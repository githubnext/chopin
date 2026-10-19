/** A saved conversation decision's durable job identity and bounded writing context. */

import { decisionGeneration, proseJobTrigger, whyJobTrigger } from "../questions/card-actions";
import * as Questions from "../questions/card-involved";
import { type Effect, type JobIntent, MAX_EFFECTS } from "./effects";
import { jobId } from "./jobs";

import type { Plan } from "../plan/service";
import type { Record as CardRecord } from "../questions/records";
import { followupIntent } from "../questions/decision-followup";

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

/**
 * A saved Planner or human decision's why-only draft: the same prose job with no paragraph, keyed
 * by its own `why:` trigger so it never collides with a conversation write-up, and carrying no
 * thread because such a decision has none.
 */
export function whyIntent(record: CardRecord): JobIntent | undefined {
	if (
		record.origin === "conversation" || record.status !== "answered"
		|| !record.owner || record.decidedAt === undefined
	) return;
	return {
		kind: "prose",
		target: record.id,
		trigger: whyJobTrigger(record.id, decisionGeneration(record)),
	};
}

export function isWhyTrigger(trigger: string): boolean {
	return trigger.startsWith("why:");
}

/** The job a saved decision enqueues: the paragraph and why for a conversation, else the why. */
export function settleIntent(record: CardRecord): JobIntent | undefined {
	return proseIntent(record) ?? whyIntent(record);
}

/** The current decision's write-up while it is unfinished. Done or skipped work has no status. */
export function writeup(
	plan: Pick<Plan, "conversationPlanJobs" | "conversationPlanPendingEffects">,
	record: CardRecord,
): { status: "writing" | "failed"; job: string } | undefined {
	let intent = proseIntent(record) ?? followupIntent(record);
	if (!intent) return;
	if (
		intent.kind === "decision-followup"
		&& record.followUp?.appliedGeneration === decisionGeneration(record)
	) return;
	let id = jobId(intent);
	let job = plan.conversationPlanJobs.find(item => item.id === id);
	if (job?.status === "failed") return { status: "failed", job: id };
	if (job?.status === "pending" || job?.status === "running") return { status: "writing", job: id };
	if (job) return;
	// Save commits the job effect before the queue accepts it.
	let queued = plan.conversationPlanPendingEffects.some(effect =>
		effect.kind === "job" && effect.intent.kind === intent.kind
		&& effect.intent.target === intent.target && effect.intent.trigger === intent.trigger
	);
	return queued ? { status: "writing", job: id } : undefined;
}

/** Save adds this to the same candidate as its answered record and mirror action. */
export function appendProseEffect(
	pending: readonly Effect[],
	receipts: readonly string[],
	record: CardRecord,
): Effect[] {
	let intent = settleIntent(record);
	if (!intent) return [...pending];
	let why = isWhyTrigger(intent.trigger);
	let effect: Effect = {
		key: `job:${why ? "why" : "prose"}:${record.id}:${decisionGeneration(record)}`,
		kind: "job",
		...(why ? {} : { threadId: record.threadId }),
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
	/** One line per ready research or spike finding. */
	findings?: string[];
	/** The findings that are not takes; the why-only prompt lists takes apart, with stances. */
	research?: string[];
	/** One line per asked member's take, with the stance they gave. */
	takes?: string[];
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
	if (input.findings?.length) {
		lines.push(
			"What exploring the decision found:",
			...input.findings.slice(0, 8).map(finding => `- ${quote(finding, 300)}`),
		);
	}
	lines.push(
		"",
		"An earlier decision paragraph may still appear in `read_plan`. It is a replacement",
		"target, not evidence for this choice. Do not reuse its claims or reasons unless the",
		"current saved choice and applicable discussion reasons above support them.",
		"State only the saved choice and supported reasons. Do not add commitments, implementation",
		"details, or claims that the conversation did not establish. Do not name people.",
		"One ordinary paragraph, at most 600 characters. Also give `why`: one plain sentence, at most",
		"300 characters, no Markdown and no names, saying why the group chose this. It must follow",
		"from the supported reasons above; if none support one, leave `why` out. Call `read_plan`",
		"for its revision, then call `write_decision_prose` once with that revision, the card id,",
		"the paragraph and `why`.",
		"Use no other writing tool. Do not reply in chat.",
	);
	return lines.join("\n");
}

/** The prompt for a job's trigger: the paragraph and why, or the why alone. */
export function settlePrompt(plan: Plan, job: { target: string; trigger: string }): string {
	return isWhyTrigger(job.trigger)
		? whyPrompt(proseInput(plan, job.target))
		: prosePrompt(proseInput(plan, job.target));
}

export function whyPrompt(input: ProsePromptInput): string {
	let lines = [
		"[Background job: why]",
		"A decision was settled. Write only the reason it went this way. Write no paragraph.",
		"",
		`Decision card id: ${quote(input.id, 200)}`,
		`Question: ${quote(input.question, 500)}`,
		`Chosen: ${input.chosen.slice(0, 10).map(value => quote(value, 200)).join("; ")}`,
	];
	if (input.research?.length) {
		lines.push(
			"What exploring the decision found:",
			...input.research.slice(0, 8).map(finding => `- ${quote(finding, 300)}`),
		);
	}
	if (input.takes?.length) {
		lines.push(
			"What people asked said:",
			...input.takes.slice(0, 8).map(take => `- ${quote(take, 300)}`),
		);
	}
	lines.push(
		"",
		"Say why this was chosen using only what is above, and invent no reason it does not give;",
		"if little is given, state the plainest benefit of the chosen answer for the question.",
		"`why` is one plain sentence, at most 300 characters, no Markdown and no names. Call",
		"`read_plan` for its revision, then call `write_decision_prose` once with that revision,",
		"the card id and `why`, and no `text`.",
		"Use no other writing tool. Do not reply in chat.",
	);
	return lines.join("\n");
}

function findingLine(finding: { title?: string; summary?: string }): string {
	return [finding.title, finding.summary].filter(Boolean).join(": ");
}

export function proseInput(plan: Plan, id: string): ProsePromptInput {
	let record = plan.records.get(id);
	if (!record || !settleIntent(record)) throw new Error("decision is no longer saved");
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
	let ready = (record.findings ?? []).filter(finding => finding.status === "ready");
	let findings = ready.map(findingLine).filter(Boolean);
	let research = ready.filter(finding => finding.kind !== "ask").map(findingLine).filter(Boolean);
	let takes = ready.filter(finding => finding.kind === "ask" && finding.summary).map(finding =>
		`${finding.stance ? `${finding.stance}: ` : ""}${finding.summary}`
	);
	return {
		id,
		question: question?.question ?? "",
		chosen,
		owner: record.owner!,
		involved: Questions.involved(plan, record),
		reasons,
		...(findings.length ? { findings } : {}),
		...(research.length ? { research } : {}),
		...(takes.length ? { takes } : {}),
	};
}
