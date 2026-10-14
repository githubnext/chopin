import type { Chat } from "@chopin/protocol";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import * as room from "../plan/room";
import type { Plan } from "../plan/service";
import { sourceHash } from "../plan/service";
import {
	DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES,
	type DocumentDevelopmentInput,
	parseDocumentDevelopmentInput,
} from "./schema";
import * as State from "./state";
import { canRetire } from "./recovery";

export function ordinary(entry: Chat.Entry): boolean {
	return entry.author.kind === "member" && !entry.to && !!entry.text.trim();
}

export function latest(plan: Plan): Chat.Entry | undefined {
	return plan.chat.entries.findLast(entry => entry.author.kind === "member" && !!entry.text.trim());
}

/** Hash complete decision meaning, not moving anchors or presentation metadata. */
export function decisionContext(plan: Plan): { hash: string; summaries: string[] } {
	let decisions = [...plan.records.values()].sort((a, b) => a.id.localeCompare(b.id)).map(
		record => ({
			id: record.id,
			status: record.status,
			definition: record.definition,
			choices: record.choices ?? [],
			answers: record.answers ?? {},
			owner: record.owner ?? record.resolver ?? "",
		}),
	);
	let comments = [...plan.threads.values()]
		.filter(record => record.status === "accepted" || record.status === "resolved" && record.result)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(record => ({
			id: record.id,
			status: record.status,
			notes: record.notes,
			quote: record.quote,
		}));
	let summaries = decisions.filter(record =>
		record.status === "answered" || record.status === "open" || record.status === "reopened"
	).map(record =>
		JSON.stringify({
			status: record.status,
			questions: record.definition.questions.map(question => ({
				question: question.question,
				chosen: question.options.filter(option => record.choices.includes(option.id))
					.map(option => option.label),
				answer: record.answers[question.id],
			})),
			owner: record.owner,
		})
	);
	for (let comment of comments) summaries.push(JSON.stringify(comment));
	return { hash: sourceHash(JSON.stringify({ decisions, comments })), summaries };
}

/** Capture whole recent messages. Oversized context is deferred rather than silently rewritten. */
export function snapshot(plan: Plan): DocumentDevelopmentInput | undefined {
	let source = room.project(plan.document);
	if (source.length > 32_000) return;
	let entries = plan.chat.entries.filter(entry =>
		entry.author.kind === "member" && !!entry.text.trim()
	);
	if (!entries.at(-1) || !ordinary(entries.at(-1)!)) return;
	let messages: DocumentDevelopmentInput["messages"] = [];
	let length = 0;
	for (let entry of entries.slice(-16).toReversed()) {
		if (entry.text.length > 4_000 || length + entry.text.length > 16_000) break;
		if (entry.author.kind !== "member") continue;
		messages.unshift({ id: entry.id, author: entry.author.handle, text: entry.text });
		length += entry.text.length;
	}
	let messageId = messages.at(-1)?.id;
	if (!messageId || messageId !== entries.at(-1)?.id) return;
	let decisions = decisionContext(plan);
	if (decisions.summaries.length > 24 || decisions.summaries.some(value => value.length > 800)) {
		return;
	}
	let state = State.capture(plan);
	let blocks = parse(source).children;
	let passages: DocumentDevelopmentInput["passages"] = [];
	let generated = 0;
	let canReplace = canRetire(plan);
	for (let passage of state?.passages ?? []) {
		let index = State.indexOf(plan.document, passage);
		let block = index === undefined ? undefined : blocks[index];
		if (!block) continue;
		let canonical = serialize({ type: "root", children: [block] });
		if (passage.status === "generated") generated += canonical.length;
		let markdown = canonical.trim();
		if (!markdown || markdown.length > 1200) continue;
		passages.push({
			id: passage.id,
			markdown,
			digest: passage.generatedDigest,
			editable: passage.status === "generated" && canReplace,
		});
	}
	let input = {
		messageId,
		revision: plan.revision,
		decisionHash: decisions.hash,
		source,
		messages,
		passages,
		decisions: decisions.summaries,
		capacity: {
			additions: Math.max(0, State.MAX_PASSAGES - (state?.passages.length ?? 0)),
			characters: Math.max(0, State.MAX_SOURCE - generated),
		},
	};
	if (Buffer.byteLength(JSON.stringify(input)) > DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES) return;
	return parseDocumentDevelopmentInput(input);
}
