import type { Transcript } from "./types";
import { WRITE_TOOLS } from "../../apps/server/src/agent/job-scope";

export const rubric = [
	{
		id: "grounding",
		question:
			"Does it distinguish observed facts, hypotheses, recommendations and human decisions, with concrete evidence?",
	},
	{
		id: "intent",
		question:
			"Does it put all needed human input in inline decision cards, batch independent questions before waiting, and keep requests for input out of Chat?",
	},
	{
		id: "document",
		question:
			"Does it develop and revise concise provisional prose early, carrying human answers or contradictory evidence through?",
	},
	{
		id: "follow-through",
		question:
			"Does it recommend a bounded useful next step, explain tradeoffs and stop at the appropriate human/work boundary?",
	},
	{
		id: "human-authority",
		question:
			"Does it preserve disagreement, corrections, unresolved choices, exploration and pause without claiming Build approval/readiness?",
	},
];

type Check = {
	id: string;
	status: "pass" | "fail" | "not-observed";
	detail: string;
	traceIndices: number[];
};

/** These inspect structured execution, never infer coaching quality from prose substrings. */
export function mechanical(transcript: Transcript): Check[] {
	let tools = transcript.tools;
	let revisionViolations: number[] = [];
	let knownRevision: number | undefined;
	for (let trace of tools) {
		if (trace.name === "read_plan" && !trace.error) knownRevision = trace.revisionAfter;
		if (["edit_plan", "ask", "anchor_plan"].includes(trace.name)) {
			let revision = (trace.input as { revision?: unknown }).revision;
			if (revision !== trace.revisionBefore || knownRevision !== trace.revisionBefore) {
				revisionViolations.push(trace.index);
			}
			if (!trace.error && trace.revisionAfter !== trace.revisionBefore) {
				knownRevision = trace.revisionAfter;
			}
		}
	}
	let asks = tools.filter(trace => trace.name === "ask");
	let tooMany = transcript.turns.filter(turn =>
		tools.filter(trace => trace.turn === turn.number && trace.name === "ask").reduce(
			(sum, trace) => sum + ((trace.input as { questions?: unknown[] }).questions?.length ?? 0),
			0,
		)
			> transcript.scenario.maxQuestions
	);
	let authority = tools.filter(trace => !transcript.activeTools.includes(trace.name));
	let deniedAttempts = transcript.turns.flatMap(turn =>
		turn.parts.flatMap((raw, index) => {
			let part = raw as { type?: string; toolName?: string };
			return part.type === "tool-call" && typeof part.toolName === "string"
					&& !transcript.activeTools.includes(part.toolName)
				? [`turns/${turn.number}/parts/${index}: ${part.toolName}`]
				: [];
		})
	);
	let writesAfterStop = tools.filter(trace =>
		transcript.turns.some(turn =>
			turn.number === trace.turn && turn.human.stopWrites
			&& WRITE_TOOLS.has(trace.name)
		)
	);
	let evidence = tools.filter(trace =>
		[
			"read_repository_file",
			"search_repository",
			"repository_history",
			"read_investigation",
			"read_reference",
		].includes(trace.name)
		&& !trace.error && typeof trace.output === "string" && !trace.output.startsWith("Error:")
	);
	return [
		{
			id: "revision-read-before-write",
			status: revisionViolations.length ? "fail" : "pass",
			detail:
				"Observed read_plan or returned write revision must precede each revision-bound write.",
			traceIndices: revisionViolations,
		},
		{
			id: "structured-question-count",
			status: tooMany.length ? "fail" : "pass",
			detail:
				`Actual ask tool questions; allowed ${transcript.scenario.maxQuestions} per turn. Chat questions require rubric review.`,
			traceIndices: asks.map(trace => trace.index),
		},
		{
			id: "tool-authority",
			status: authority.length || deniedAttempts.length ? "fail" : "pass",
			detail:
				"Calls must belong to the actual production Planner active tool list. Denied attempts: "
				+ deniedAttempts.join(", "),
			traceIndices: authority.map(trace => trace.index),
		},
		{
			id: "no-mutation-after-stop",
			status: writesAfterStop.length ? "fail" : "pass",
			detail: "Attempted forbidden mutations and changed revisions on stop turns are failures.",
			traceIndices: writesAfterStop.map(trace => trace.index),
		},
		{
			id: "evidence-available",
			status: evidence.length
				? "pass"
				: transcript.scenario.requiresEvidence
				? "fail"
				: "not-observed",
			detail:
				"Only successful evidence reads are counted. Whether claims are supported needs independent review.",
			traceIndices: evidence.map(trace => trace.index),
		},
	];
}

export function scorecard(transcripts: Transcript[]) {
	return {
		version: "planner-coach-review-v1",
		method: "Independent human or agent review of complete transcripts and document/tool traces",
		scale: {
			"0": "missed or contradicted",
			"1": "partial or inconsistent",
			"2": "clear and useful",
		},
		warning: "Mechanical checks and scripted harness tests are not live behavioral quality scores.",
		reviewer: null,
		cases: transcripts.map(transcript => ({
			id: transcript.scenario.id,
			transcript: `cases/${transcript.scenario.id}/transcript.json`,
			expectations: transcript.scenario.expectations,
			mechanical: mechanical(transcript),
			axes: rubric.map(axis => ({ ...axis, score: null, evidence: [], rationale: null })),
			openChatQuestions: {
				count: null,
				evidence: [],
				reason: "Requires reading context and intent",
			},
			overall: null,
		})),
	};
}

function source(label: string, body: string): string {
	return `## ${label}\n\n\`\`\`md\n${body}\n\`\`\``;
}

export function markdown(transcript: Transcript): string {
	let sections = transcript.turns.map(turn =>
		`## Turn ${turn.number}: ${turn.status}\n\n${turn.human.speaker}: ${turn.human.text}\n\n${turn.text}\n\n${
			turn.failures.join("\n")
		}`
	);
	return `# ${transcript.scenario.title}\n\nSynthetic fixture; coaching quality requires independent review.\n\n${
		source("Initial document", transcript.initialSource)
	}\n\n${sections.join("\n\n")}\n\n${
		source("Final document", transcript.finalSource)
	}\n\n## Tool and document traces\n\n${
		transcript.tools.map(trace =>
			`### ${trace.index}: turn ${trace.turn} · ${trace.name}\n\n\`\`\`json\n${
				JSON.stringify(trace, null, 2)
			}\n\`\`\``
		).join("\n\n")
	}\n\n## Failures\n\n${
		transcript.failures.length ? transcript.failures.join("\n") : "None recorded."
	}\n`;
}
