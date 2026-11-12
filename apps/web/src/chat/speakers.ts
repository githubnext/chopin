/**
 * Who speaks in a Chat row, and what research delegation shows, from Chopin's own state.
 *
 * A person is a plain Slack row. Everyone else is an app, as Slack would draw one: the Planner is
 * an `agent`, a research child a `subagent` and a tool call a `tool`, each tagged with its kind
 * beside its name. The handoff and subagent list are the props of assistant-ui's standalone
 * `AgentHandoff` and `SubagentList`.
 */
import { displayName, PLANNER_NAME } from "@chopin/editor";

import { duration, toolCopy } from "./model";

import type { SubagentItem } from "@/components/assistant-ui/elements/subagent-list";
import type { Chat, ConversationPlan, Research } from "@chopin/protocol";

export type SpeakerKind = "user" | "agent" | "subagent" | "tool";

/** The words of the tag beside an app's name, as Slack's `APP`. A person has none. */
export const SPEAKER_TAGS: Record<Exclude<SpeakerKind, "user">, string> = {
	agent: "Agent",
	subagent: "Subagent",
	tool: "Tool",
};

export type Speaker = {
	kind: SpeakerKind;
	name: string;
	/** What sits beside the name: the time, or when a running turn started. */
	time?: string;
	handle?: string;
};

/**
 * One formatter for every message's time. `toLocaleTimeString` builds a formatter on each call, and
 * a long Chat asks for hundreds of times on every render.
 */
let clockFormat: Intl.DateTimeFormat | undefined;

export function when(ts: number): string {
	clockFormat ??= new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
	return clockFormat.format(new Date(ts * 1000));
}

export function messageSpeaker(input: {
	author: Exclude<Chat.Author, { kind: "system" }>;
	ts?: number;
	activeTs?: number;
}): Speaker {
	let time = input.activeTs !== undefined
		? `Started at ${when(input.activeTs)}`
		: input.ts !== undefined
		? when(input.ts)
		: undefined;
	let speaker: Speaker = input.author.kind === "member"
		? { kind: "user", name: displayName(input.author.handle), handle: input.author.handle }
		: { kind: "agent", name: PLANNER_NAME };
	if (time !== undefined) speaker.time = time;
	return speaker;
}

/** A research child speaking: its ready notice, its failure, or its report card. */
export function researchSpeaker(ts?: number): Speaker {
	let speaker: Speaker = { kind: "subagent", name: "Research" };
	if (ts !== undefined) speaker.time = when(ts);
	return speaker;
}

export type ToolStatusLabel = "Running" | "Last seen running" | "Interrupted" | "Failed" | "Done";

/** A tool call's state, and what its line says beside the name: how long it took, or why not. */
export function toolState(
	tool: Chat.Activity,
	context: { active: boolean; disconnected: boolean },
): { status: ToolStatusLabel; toolStatus: string; detail?: string } {
	let status: ToolStatusLabel = tool.status === "running"
		? context.disconnected ? "Last seen running" : context.active ? "Running" : "Interrupted"
		: tool.status === "failed"
		? "Failed"
		: "Done";
	let detail = status === "Done"
		? tool.took !== undefined ? duration(tool.took) : undefined
		: status === "Running"
		? undefined
		: status;
	return {
		status,
		toolStatus: context.active || context.disconnected ? tool.status : status.toLowerCase(),
		...(detail !== undefined ? { detail } : {}),
	};
}

export function toolSpeaker(tool: Chat.Activity): Speaker {
	return { kind: "tool", name: toolCopy(tool.name) };
}

export type HandoffProps = {
	from: string;
	to: string;
	reason: string;
	carried: readonly string[];
	settled: boolean;
};

export function researchOfferHandoff(
	offer: { workflow?: { sources: readonly Pick<ConversationPlan.ResearchSource, "quote">[] } },
	stage: Research.RequestStage,
): HandoffProps {
	let carried = [
		...new Set(
			(offer.workflow?.sources ?? []).map(source => source.quote.trim()).filter(Boolean),
		),
	].slice(0, 3);
	let reason = stage === "queued"
		? "Handing off the research brief to a child document."
		: stage === "ready"
		? "Published findings in a child document."
		: stage === "failed"
		? "Stopped before publishing a child document."
		: stage === "cancelled"
		? "Cancelled before publishing a child document."
		: "Investigating sources for a child document.";
	return { from: PLANNER_NAME, to: "Research", reason, carried, settled: stage !== "queued" };
}

export type SubagentsProps = {
	agents: readonly SubagentItem[];
	completedCount: number;
	progress: readonly number[];
	showSummary: boolean;
	summaryAgent: SubagentItem;
};

const RESEARCH_AGENTS: readonly SubagentItem[] = [
	{ name: "Public web search", model: "web" },
	{ name: "Repository context", model: "repo" },
];

const WRITE: SubagentItem = { name: "Write research report", model: "report" };
const PUBLISH: SubagentItem = { name: "Publish research document", model: "report" };

/**
 * The research pipeline's workers at a request's stage. The split and the progress values are a
 * picture of the pipeline's stages, not per-worker telemetry, which Chopin does not have.
 */
export function researchOfferSubagents(
	stage: Research.RequestStage,
): SubagentsProps | undefined {
	let base = { agents: RESEARCH_AGENTS, summaryAgent: WRITE };
	switch (stage) {
		case "queued":
			return { ...base, completedCount: 0, progress: [0, 0], showSummary: false };
		case "searching":
			return { ...base, completedCount: 0, progress: [55, 15], showSummary: false };
		case "analyzing":
			return { ...base, completedCount: 1, progress: [100, 65], showSummary: false };
		case "writing":
			return { ...base, completedCount: 2, progress: [100, 100], showSummary: true };
		case "publishing":
			return {
				...base,
				completedCount: 2,
				progress: [100, 100],
				showSummary: true,
				summaryAgent: PUBLISH,
			};
		default:
			return undefined;
	}
}

/** The handoff a Planner turn makes when it calls `create_research_workspace`. */
export function plannerResearchHandoff(
	tools: readonly Chat.Activity[],
): HandoffProps | undefined {
	let call = tools.findLast(
		tool =>
			tool.name === "create_research_workspace"
			&& (tool.status === "running" || tool.status === "done"),
	);
	if (!call) return undefined;
	let question: string | undefined;
	if (call.args) {
		try {
			let parsed = JSON.parse(call.args) as { question?: unknown };
			if (typeof parsed?.question === "string" && parsed.question.trim()) {
				question = parsed.question.trim();
			}
		} catch {
			// Streamed or partial arguments fall back to the generic reason.
		}
	}
	return {
		from: PLANNER_NAME,
		to: "Research",
		reason: question ?? "Handing off the research brief to a child document.",
		carried: [],
		settled: call.status === "done",
	};
}
