/** Fixed, bounded instructions for one background Planner job. */

import type { Chat, ConversationPlan } from "@chopin/protocol";
import * as edit from "../plan/edit";
import { proseInput, prosePrompt } from "./prose-job";
import type { Plan } from "../plan/service";

function quote(value: string, max = 500): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function source(ref: ConversationPlan.SourceRef | undefined): string {
	if (!ref) return "";
	let label = ref.role === "option" ? "option_source" : ref.role === "question"
		? "question_source"
		: "context_source";
	return ` ${label}=${
		JSON.stringify({
			messageId: ref.messageId,
			author: ref.author,
			quote: ref.quote,
			start: ref.start,
			end: ref.end,
			role: ref.role,
		})
	}`;
}

function boundedLines(lines: string[], max: number): string {
	let kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		let line = lines[index]!;
		let length = line.length + (kept.length ? 1 : 0);
		if (used + length > max) continue;
		kept.unshift(line);
		used += length;
	}
	return kept.join("\n");
}

function outline(plan: Plan): string {
	return edit.outline(plan).slice(0, 50)
		.map(block => `${block.index} ${block.type} ${block.digest} ${quote(block.preview, 120)}`)
		.join("\n");
}

export function headingPrompt(input: { transcript: Chat.Entry[]; outline: string }): string {
	let said = input.transcript
		.filter(entry => entry.author.kind === "member")
		.slice(-15)
		.map(entry =>
			`- @${quote((entry.author as Extract<Chat.Author, { kind: "member" }>).handle, 80)}: ${
				quote(entry.text)
			}`
		)
		.join("\n");
	return [
		"[Background job: heading]",
		"People have started discussing a new, empty document. Give it a title and a one-sentence goal.",
		"",
		"Recent conversation:",
		said || "(none)",
		"",
		"Current document outline:",
		input.outline.slice(0, 6000) || "(empty)",
		"",
		"Call `read_plan`, then call `draft_heading` once with its revision, a short title (at most",
		"80 characters, no `#`) and a goal of one sentence in the team's own terms, starting",
		'"Goal:". Describe what they are trying to decide, not a decision they have not made.',
		"Use no other writing tool. Do not reply in chat.",
	].join("\n");
}

export function refinePrompt(input: {
	kind: "refine" | "suggest";
	id: string;
	question: string;
	options: string[];
	thread?: ConversationPlan.Thread;
	outline: string;
	revision: number;
}): string {
	let { kind, thread } = input;
	let labels = new Map(
		thread?.contributions.filter(item => item.kind === "option")
			.map(item => [item.id, quote(item.text, 200)] as const) ?? [],
	);
	let evidence = boundedLines(
		thread?.contributions.slice(-20).map(item =>
			`- ${item.kind}: ${quote(item.text)}${source(item.sources[0])}`
		) ?? [],
		6000,
	);
	let questionSources = boundedLines(
		thread?.questionSources?.slice(-20).map(ref => `- ${source(ref).trim()}`) ?? [],
		4000,
	);
	let stances = boundedLines(
		thread?.stances.slice(-20).map(stance =>
			`- @${quote(stance.participant, 80)} ${stance.position}s ${
				labels.get(stance.optionId ?? "") ?? quote(stance.optionId ?? "the question", 200)
			}${source(stance.sources[0])}`
		) ?? [],
		4000,
	);
	let task = kind === "refine"
		? [
			"1. Reword the title to ask which approach the team should choose for the actual task,",
			"   not which options exist or are installed. Keep the meaning, use at most 80 characters,",
			'   and end with "?".',
			"2. Add options only when the discussion, the repository or the document justifies them.",
			"3. If the card belongs after a particular block of prose, give `place_after` with that",
			"   block's index and digest from `read_plan`. Otherwise leave it where it is.",
		]
		: [
			"People added options in chat. Consider whether an obvious, sensible option is still",
			"missing. Do not change the title and do not move the card.",
		];
	return [
		`[Background job: ${kind}]`,
		`Decision card ${quote(input.id, 200)}: "${quote(input.question)}"`,
		"",
		"Options so far:",
		input.options.slice(0, 10).map((label, index) => `${index + 1}. ${quote(label, 200)}`)
			.join("\n") || "(none)",
		"",
		...(questionSources ? ["Question mentions:", questionSources, ""] : []),
		...(evidence ? ["What people said:", evidence, ""] : []),
		...(stances ? ["Positions:", stances, ""] : []),
		"Document outline:",
		input.outline.slice(0, 6000) || "(empty)",
		"",
		...task,
		"",
		"Each option must name one actionable approach. Split mutually exclusive alternatives",
		"mentioned together (such as A or B or C, including slash lists) into separate options.",
		"Keep related APIs that",
		"form one approach together. Compare the underlying approaches, not just exact labels,",
		"against existing options and each other; do not add a reworded or grouped duplicate.",
		"For each addition, write a one-sentence rationale tied to a specific conversation source",
		"above or to identifiable document/repository evidence. If the evidence or the split is",
		"unclear, omit that addition. Do not invent a source or rationale.",
		"Only a displayed `option_source` with role `option` or a `question_source` with role",
		"`question` may be copied unchanged into `add_options[].source`, including UTF-16",
		"start/end and exact quote. A question mention names possibilities; it does not",
		"endorse either choice. Use it as provenance only when the quote names the option",
		"with the option's own terms, not as evidence of support. Keep a question-sourced",
		"option label faithful to the named alternative; do not add specificity that the",
		"question did not name. Never copy a",
		"`context_source` from a reason, constraint, or stance into that field. Those may inform",
		"the rationale, but omit `source` when neither exact source is shown. Do not derive",
		"offsets or quotes from the shortened summary. For repository/document evidence, omit",
		"`source`.",
		"The card holds at most 10 options. Adding nothing is a good result when nothing is missing.",
		`Call \`read_plan\`, then call \`refine_decision\` exactly once with id ${
			quote(input.id, 200)
		}.`,
		"Use no other writing tool. Do not reply in chat.",
	].join("\n");
}

function card(plan: Plan, job: ConversationPlan.Job, kind: "refine" | "suggest"): string {
	let record = plan.records.get(job.target);
	let question = record?.definition.questions[0];
	let thread = plan.conversationPlan.threads.find(item => item.questionnaireId === job.target);
	return refinePrompt({
		kind,
		id: job.target,
		question: question?.question ?? "",
		options: question?.options.map(option => option.label) ?? [],
		thread,
		outline: outline(plan),
		revision: plan.revision,
	});
}

export const PROMPT_FOR: Record<
	ConversationPlan.JobKind,
	((plan: Plan, job: ConversationPlan.Job) => string) | undefined
> = {
	heading: plan => headingPrompt({ transcript: plan.chat.entries, outline: outline(plan) }),
	refine: (plan, job) => card(plan, job, "refine"),
	suggest: (plan, job) => card(plan, job, "suggest"),
	prose: (plan, job) => prosePrompt(proseInput(plan, job.target)),
};
