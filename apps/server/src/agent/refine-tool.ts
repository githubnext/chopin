import { parse } from "@chopin/dialect/parse";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { matchesQuestionSource, questionMentionsOption } from "../questions/records";
import { atomicOptionQuote, grouped, sameApproach } from "../questions/option-match";
import { validateSource } from "../conversation-plan/sources";
import { extractQuotes } from "../conversation-plan/quotes";
import { input, type Option } from "./refine-fields";
import { placeCard } from "./refine-placement";
import type { Context } from "./card-tool-context";
import type { ConversationPlan } from "@chopin/protocol";

export async function refineDecision(
	context: Context,
	job: ConversationPlan.Job,
	turn: Context["plan"]["chat"]["turn"],
	raw: unknown,
): Promise<{
	output: { title: string; added: number };
	title: string;
	added: string[];
	skipped: string[];
	full: string[];
	placed: boolean;
}> {
	return context.exclusive(async () => {
		let { plan } = context;
		let active = () =>
			plan.chat.job === job && plan.chat.turn === turn
			&& job.status === "running" && (job.kind === "refine" || job.kind === "suggest");
		let ensureActive = () => {
			if (!active()) throw new Error("background Planner job changed before its tool completed");
		};
		ensureActive();
		let args = input(raw);
		if (args.id !== job.target) throw new Error("This job refines a different decision.");
		if (job.kind === "suggest" && (args.title !== undefined || args.place_after !== undefined)) {
			throw new Error("title and place_after are only changed by a refine job.");
		}
		if (args.revision !== plan.revision) throw new Error("stale; read_plan again");
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let record = plan.records.get(args.id);
		let live = Store.get(plan.questions, args.id);
		if (
			!record || !Questions.isOpenStatus(record.status) || !live || live.claim
			|| record.definition.questions.length !== 1
		) throw new Error("That decision is no longer open.");
		let question = record.definition.questions[0]!;
		if (live.definition.questions[0]?.id !== question.id) {
			throw new Error("That decision is no longer open.");
		}
		if (!room.hasQuestionnaire(plan.document, args.id, question.id)) {
			throw new Error("Card is not available");
		}
		if (args.place_after) {
			let at = args.place_after;
			let hashes = room.digests(plan.document);
			if (hashes[at.index] !== at.digest) {
				throw new Error(`block ${at.index} has changed; read_plan again.`);
			}
			let block = parse(room.project(plan.document)).children[at.index];
			if (!block || block.type === "mdxJsxFlowElement") {
				throw new Error("place_after must address a prose block");
			}
		}

		// Classify every option before the first durable edit, so invalid later input
		// cannot leave an earlier title or placement committed by itself.
		for (let option of args.add_options) {
			if (!option.source) continue;
			if (option.source.author.kind !== "member") {
				throw new Error("option source must come from a member");
			}
			if (
				option.source.role === "option"
				&& !atomicOptionQuote(option.source.quote, option.label)
			) {
				throw new Error("option source does not name one card option");
			}
			if (option.source.role === "question") {
				let thread = plan.conversationPlan.threads.find(item =>
					item.id === record.threadId && item.questionnaireId === args.id
				);
				if (
					!matchesQuestionSource(option.source, thread)
					|| !questionMentionsOption(option.source.quote, option.label)
				) {
					throw new Error("option question source does not name this card option");
				}
			}
			let message = plan.chat.entries.find(entry => entry.id === option.source?.messageId);
			if (!message) throw new Error("option source message missing from room transcript");
			validateSource(option.source, message);
		}
		let seen = question.options.map(option => option.label);
		let count = question.options.length;
		let additions: Option[] = [];
		let skipped: string[] = [];
		let full: string[] = [];
		for (let option of args.add_options) {
			if (grouped(option.label) || seen.some(label => sameApproach(label, option.label))) {
				skipped.push(option.label);
			} else if (count >= 10) full.push(option.label);
			else {
				seen.push(option.label);
				count++;
				additions.push(option);
			}
		}
		for (let option of additions) {
			if (option.source) continue;
			let matches = plan.chat.entries.flatMap(message => {
				if (message.author.kind !== "member" || message.streaming) return [];
				let handle = message.author.handle;
				let candidates;
				try {
					candidates = extractQuotes(message.text);
				} catch {
					return [];
				}
				return candidates.filter(candidate => atomicOptionQuote(candidate.quote, option.label)).map(
					candidate => ({ message, candidate, handle }),
				);
			});
			if (matches.length !== 1) continue;
			let { message, candidate, handle } = matches[0]!;
			option.source = {
				messageId: message.id,
				author: { kind: "member", handle },
				...candidate,
				role: "option",
			};
		}

		// Placement runs first, against the exact prose digest supplied by the job.
		// A later title or option changes only the card, never this prose address.
		let placed = false;
		if (args.place_after) {
			ensureActive();
			placed = await placeCard(context, args.id, args.place_after, ensureActive);
		}
		let title = question.question;
		if (args.title !== undefined) {
			ensureActive();
			let done = await Questions.retitle(
				plan,
				context.server,
				context.room,
				args.id,
				args.title,
				true,
				ensureActive,
			);
			if (!done.ok) throw new Error(done.message);
			title = args.title;
		}
		let added: string[] = [];
		for (let option of additions) {
			ensureActive();
			let result = await Questions.addServerOption(
				plan,
				context.server,
				context.room,
				args.id,
				{
					label: option.label,
					rationale: option.rationale,
					origin: "planner",
					...(option.source ? { source: option.source } : {}),
				},
				true,
				ensureActive,
			);
			if (!result.ok) throw new Error(`option addition was refused: ${result.reason}`);
			added.push(result.optionId);
		}
		return { output: { title, added: added.length }, title, added, skipped, full, placed };
	});
}
