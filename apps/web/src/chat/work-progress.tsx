import { useSyncExternalStore } from "react";
import { DecisionIcon } from "@chopin/icons";

import {
	summarize,
	toolCopy,
	toolGlyph,
	waitingCards,
	waitingPrompts,
	waitingText,
	workPhase,
} from "./model";
import { TOOL_ICONS, WorkSummary } from "./work-summary";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceScribble,
	TraceTitle,
} from "../trace";

import { cardStatus } from "@chopin/dialect";
import type { Questionnaire } from "@chopin/dialect";
import type { Chat } from "@chopin/protocol";
import type { TranscriptDecisions } from "./transcript";
import type { QuestionnaireStore } from "@chopin/editor";

const NO_QUESTIONS: ReturnType<QuestionnaireStore["snapshot"]> = [];
const noQuestions = () => () => {};
const emptyQuestions = () => NO_QUESTIONS;

function isOpen(value: Questionnaire): boolean {
	try {
		let status = cardStatus(value);
		return status === "open" || status === "reopened";
	} catch {
		return false;
	}
}

function ToolCall(
	{ active, disconnected, tool }: { active: boolean; disconnected: boolean; tool: Chat.Activity },
) {
	let hasDetails = tool.args !== undefined || tool.result !== undefined || tool.error !== undefined;
	let status = tool.status === "running"
		? disconnected ? "Last seen running" : active ? "Running" : "Interrupted"
		: tool.status === "failed"
		? "Failed"
		: "Done";
	let glyph = toolGlyph(tool.name);
	let Icon = TOOL_ICONS[glyph];
	let line = (
		<TraceLine
			status={status === "Running"
				? "running"
				: status === "Failed"
				? "error"
				: tool.status === "running"
				? "pending"
				: undefined}
		>
			<TraceIcon>
				{status === "Running" && glyph !== "ask" ? <TraceScribble /> : <Icon size={14} />}
			</TraceIcon>
			<TraceTitle wrap>{toolCopy(tool.name)}</TraceTitle>
			{status === "Running" || status === "Done"
				? <span className="sr-only">{status}</span>
				: <TraceDescription>{status}</TraceDescription>}
		</TraceLine>
	);
	let toolStatus = active || disconnected ? tool.status : status.toLowerCase();

	if (!hasDetails) {
		return <div data-tool-status={toolStatus} role="listitem">{line}</div>;
	}
	return (
		<div data-tool-status={toolStatus} role="listitem">
			<TraceCollapsible>
				<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
				<TraceCollapsibleContent surface="tool-call">
					<div className="chat-tool-call-details">
						{tool.args !== undefined && (
							<div>
								<div className="chat-tool-data-label">Input</div>
								<pre>{tool.args}</pre>
							</div>
						)}
						{(tool.result !== undefined || tool.error !== undefined) && (
							<div>
								<div className="chat-tool-data-label">Result</div>
								{tool.error
									? (
										<pre>
									<span className="block font-semibold text-destructive-ink">
										{tool.error.kind ?? tool.error.code}
									</span>
									{tool.result}
										</pre>
									)
									: <pre>{tool.result}</pre>}
							</div>
						)}
					</div>
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</div>
	);
}

export function WorkProgress(
	{ active, decisions, disconnected = false, responseSeen, streaming, tools }: {
		active: boolean;
		decisions?: TranscriptDecisions;
		disconnected?: boolean;
		responseSeen: boolean;
		streaming: boolean;
		tools: Chat.Activity[];
	},
) {
	let values = useSyncExternalStore(
		decisions?.questions.subscribe ?? noQuestions,
		decisions?.questions.snapshot ?? emptyQuestions,
		decisions?.questions.snapshot ?? emptyQuestions,
	);
	let prompts = active ? waitingPrompts(tools) : undefined;
	let waiting = prompts === undefined ? undefined : waitingCards(
		prompts,
		values.map(({ id, value }) => ({
			id,
			prompts: value.questions.map(question => question.prompt),
			open: isOpen(value),
		})),
	);
	let first = waiting?.ids[0];
	let summary = summarize(tools, active || disconnected);
	let phase = workPhase(tools, streaming, active, responseSeen);
	if (!active && !disconnected && !tools.length) return null;

	let headline = active ? waiting ? waitingText(waiting.count) : phase! : "Connection lost";
	let count = active && summary.finished > 0 ? `${summary.finished} finished` : undefined;
	let line = active || !tools.length
		? (
			<TraceLine status={active && !waiting ? "running" : undefined}>
				{waiting
					? (
						<TraceIcon>
							<DecisionIcon size={14} />
						</TraceIcon>
					)
					: active && (
						<TraceIcon>
							<TraceScribble />
						</TraceIcon>
					)}
				<TraceTitle enter key={headline}>{headline}</TraceTitle>
				{count && <TraceDescription>{count}</TraceDescription>}
			</TraceLine>
		)
		: <WorkSummary disconnected={disconnected} summary={summary} tools={tools} />;
	let open = decisions && first && (
		<button
			aria-label="Open decision"
			className="btn btn-sm btn-ghost shrink-0"
			onClick={() => decisions.onOpenCard(first)}
			type="button"
		>
			Open
		</button>
	);

	return (
		<div
			className="chat-work"
			data-tool-waiting={waiting ? "" : undefined}
			data-work-active={active}
			data-work-disconnected={disconnected}
		>
			{tools.length > 0
				? (
					<TraceCollapsible>
						<div className="chat-work-row">
							<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
							{open}
						</div>
						<TraceCollapsibleContent surface="chat-tools">
							<Trace label="Tool calls" list scroll>
								{tools.map(tool => (
									<ToolCall active={active} disconnected={disconnected} key={tool.id} tool={tool} />
								))}
							</Trace>
						</TraceCollapsibleContent>
					</TraceCollapsible>
				)
				: (
					<div className="chat-work-row">
						{line}
						{open}
					</div>
				)}
		</div>
	);
}
