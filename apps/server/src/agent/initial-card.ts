import { ULID } from "@chopin/dialect";
import { parse } from "@chopin/dialect/parse";
import * as Question from "@chopin/question";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { broadcast } from "../wire";
import * as Questions from "../questions/service";
import { applyEvent } from "../conversation-plan/events";
import { initialThread } from "../conversation-plan/planner-job-support";
import { appendEffects } from "../conversation-plan/processor-fields";
import { validateSource } from "../conversation-plan/sources";
import type { ConversationPlan } from "@chopin/protocol";
import type { Context } from "./card-tool-context";
import type { Input } from "./refine-fields";

/** Runs under the document lock; the generated wording and card link publish together. */
export async function createInitialCard(
	context: Context,
	job: ConversationPlan.Job,
	args: Input,
	ensureActive: () => void,
) {
	let { plan } = context;
	if (!plan.conversationPlanJobs.includes(job)) {
		throw new Error("Initial card generation requires its durable running job.");
	}
	let thread = initialThread(plan, job);
	if (!thread) throw new Error("The conversation decision is no longer open.");
	let suggestions = () =>
		appendEffects(plan, [{
			key: `job:suggest:${job.target}:initial`,
			kind: "job",
			threadId: thread.id,
			intent: { kind: "suggest", target: job.target, trigger: job.trigger },
		}]);
	let existing = plan.records.get(job.target);
	if (existing) {
		if (
			existing.threadId !== thread.id
			|| thread.questionnaireId && thread.questionnaireId !== existing.id
		) {
			throw new Error("The reserved decision card belongs to another thread.");
		}
		if (!thread.questionnaireId) {
			// Older servers committed the card and its link separately. Recover that exact card.
			let conversationPlan = applyEvent(plan.conversationPlan, {
				id: `card:${job.target}:linked`,
				type: "card.linked",
				threadId: thread.id,
				observedThreadVersion: thread.version,
				origin: "classifier",
				actor: { kind: "classifier" },
				at: Math.floor(Date.now() / 1_000),
				questionnaireId: job.target,
			});
			ensureActive();
			await Service.publishStaged(plan, context.server, context.room, {
				...plan,
				conversationPlan,
				conversationPlanPendingEffects: suggestions(),
			});
			broadcast(context.server, context.room, {
				kind: "conversation-plan:changed",
				ts: 0,
				state: conversationPlan,
			});
		}
		let title = existing.definition.questions[0]!.question;
		return { output: { title, added: 0 }, title, added: [], skipped: [], full: [], placed: false };
	}
	if (thread.questionnaireId) throw new Error("The linked decision card is missing.");
	if (!args.title) throw new Error("Initial card generation requires a short title.");
	if (args.add_options.length) {
		throw new Error("Initial card generation preserves discussion options; omit add_options.");
	}
	if (!thread.questionSources.length) throw new Error("The conversation question has no source.");
	for (let source of thread.questionSources) {
		let message = plan.chat.entries.find(entry => entry.id === source.messageId);
		if (!message) throw new Error("The conversation question source is missing.");
		validateSource(source, message);
	}
	if (args.place_after) {
		let at = args.place_after;
		if (room.digests(plan.document)[at.index] !== at.digest) {
			throw new Error(`block ${at.index} has changed; read_plan again.`);
		}
		let block = parse(room.project(plan.document)).children[at.index];
		if (!block || block.type === "mdxJsxFlowElement") {
			throw new Error("place_after must address a prose block");
		}
	}
	let linked = applyEvent(plan.conversationPlan, {
		id: `card:${job.target}:linked`,
		type: "card.linked",
		threadId: thread.id,
		observedThreadVersion: thread.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: Math.floor(Date.now() / 1_000),
		questionnaireId: job.target,
	});
	let options = thread.contributions.filter(item => item.kind === "option" && ULID.test(item.id))
		.slice(0, Question.limits.MAX_DECISION_OPTIONS).map(item => {
			let source = item.sources.find(source => source.role === "option");
			return {
				id: item.id,
				label: item.text.trim().slice(0, Question.limits.MAX_LABEL),
				...(source ? { source } : {}),
			};
		});
	await Questions.insertConversationCard(plan, context.server, context.room, {
		id: job.target,
		threadId: thread.id,
		header: thread.question.trim().slice(0, Question.limits.MAX_HEADER),
		question: args.title,
		...(args.description !== undefined ? { description: args.description } : {}),
		options,
	}, {
		conversationPlan: linked,
		conversationPlanPendingEffects: suggestions(),
		placeAfter: args.place_after,
		beforePublish: () => {
			ensureActive();
			if (initialThread(plan, job) !== thread) {
				throw new Error("The conversation decision changed.");
			}
		},
	});
	return {
		output: { title: args.title, added: 0 },
		title: args.title,
		added: [],
		skipped: [],
		full: [],
		placed: !!args.place_after,
	};
}
