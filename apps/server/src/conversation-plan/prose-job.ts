/** A saved conversation decision's durable job identity and bounded writing context. */

import { parse } from "@chopin/dialect";

import * as room from "../plan/room";
import { decisionGeneration, proseJobTrigger } from "../questions/card-actions";
import * as Questions from "../questions/card-involved";
import { type Effect, type JobIntent, MAX_EFFECTS } from "./effects";

import type { Plan } from "../plan/service";
import type { Record as CardRecord } from "../questions/records";

export function proseIntent(record: CardRecord): JobIntent | undefined {
	if (
		record.origin !== "conversation" || !record.threadId || record.status !== "answered"
		|| !record.owner || record.decidedAt === undefined
	) return;
	return {
		kind: "prose",
		target: record.id,
		trigger: proseJobTrigger(record.id, decisionGeneration(record)),
	};
}

/** Save adds this to the same candidate as its answered record and mirror action. */
export function appendProseEffect(
	pending: readonly Effect[],
	receipts: readonly string[],
	record: CardRecord,
): Effect[] {
	let intent = proseIntent(record);
	if (!intent) return [...pending];
	let effect: Effect = {
		key: `job:prose:${record.id}:${decisionGeneration(record)}`,
		kind: "job",
		threadId: record.threadId,
		intent,
	};
	if (receipts.includes(effect.key)) return [...pending];
	let existing = pending.find(item => item.key === effect.key);
	if (existing) {
		if (
			existing.kind !== "job" || existing.threadId !== effect.threadId
			|| existing.intent.kind !== intent.kind || existing.intent.target !== intent.target
			|| existing.intent.trigger !== intent.trigger
		) throw new Error("conversation effect key collision");
		return [...pending];
	}
	if (pending.length >= MAX_EFFECTS) throw new Error("conversation effect outbox is full");
	return [...pending, effect];
}

export type ProsePromptInput = {
	id: string;
	question: string;
	chosen: string[];
	owner: string;
	involved: string[];
	reasons: string[];
	existing?: string;
};

function quote(value: string, max: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function prosePrompt(input: ProsePromptInput): string {
	let others = input.involved.filter(handle => handle !== input.owner).slice(0, 8);
	let lines = [
		"[Background job: prose]",
		"A person saved a decision. Write exactly one grounded paragraph in the document's voice.",
		"",
		`Decision card id: ${quote(input.id, 200)}`,
		`Question: ${quote(input.question, 500)}`,
		`Chosen: ${input.chosen.slice(0, 10).map(value => quote(value, 200)).join("; ")}`,
		`Saved by: ${quote(input.owner, 80)}${
			others.length ? `; discussed with ${others.map(value => quote(value, 80)).join(", ")}` : ""
		}`,
	];
	if (input.reasons.length) {
		lines.push(
			"Reasons given in the discussion:",
			...input.reasons.slice(0, 12).map(reason => `- ${quote(reason, 300)}`),
		);
	}
	if (input.existing) {
		lines.push(
			"",
			"The decision was reopened and decided again. Its existing paragraph reads:",
			quote(input.existing, 600),
		);
	}
	lines.push(
		"",
		"State only the saved choice and supported reasons. Do not add commitments, implementation",
		"details, or claims that the conversation did not establish. Do not name people.",
		"One ordinary paragraph, at most 600 characters. Call `read_plan` for its revision, then",
		"call `write_decision_prose` once with that revision, the card id, and the paragraph.",
		"Use no other writing tool. Do not reply in chat.",
	);
	return lines.join("\n");
}

/** Resolve any prior paragraph by live anchor identity, never by its first matching digest. */
export function proseInput(plan: Plan, id: string): ProsePromptInput {
	let record = plan.records.get(id);
	if (!record || !proseIntent(record)) throw new Error("decision is no longer saved");
	let question = record.definition.questions[0];
	let selected = new Set(record.choices ?? []);
	let chosen: string[] = [];
	for (let item of record.definition.questions) {
		let options = item.options.filter(option => selected.has(option.id));
		if (options.length) chosen.push(...options.map(option => option.label));
		else if (record.answers?.[item.id]) chosen.push(record.answers[item.id]!);
	}
	let thread = plan.conversationPlan.threads.find(item => item.questionnaireId === id);
	let reasons = thread?.contributions
		.filter(item =>
			item.kind === "reason" && (!item.targetId || item.targetId === thread.id
				|| selected.has(item.targetId))
		)
		.map(item => item.text) ?? [];
	let anchor = record.prose?.length === 1 && !record.prose[0]?.orphaned
		? record.prose[0]
		: undefined;
	let index = anchor
		? room.digests(plan.document).findIndex((_, at) =>
			room.matchesAnchor(plan.document, anchor, at)
		)
		: -1;
	let block = index >= 0 ? parse(room.project(plan.document)).children[index] : undefined;
	return {
		id,
		question: question?.question ?? "",
		chosen,
		owner: record.owner!,
		involved: Questions.involved(plan, record),
		reasons,
		...(block?.type === "paragraph" ? { existing: room.blockText(plan.document, [index]) } : {}),
	};
}
