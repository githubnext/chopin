import { useId, useState, useSyncExternalStore } from "react";
import { ChevronIcon, DecisionIcon } from "@chopin/icons";
import { MotionDisclosure, MotionDisclosureIcon } from "@chopin/editor";

import {
	duration,
	summarize,
	toolCopy,
	waitingCards,
	waitingPrompts,
	waitingText,
	workPhase,
} from "./model";
import { motionContract } from "../motion-contract";
import { motionImmediately } from "../motion-input";

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
	let [open, setOpen] = useState(false);
	let contentId = useId();
	let hasDetails = tool.args !== undefined || tool.result !== undefined;
	let status = tool.status === "running"
		? disconnected ? "Last seen running" : active ? "Running" : "Interrupted"
		: tool.status === "failed"
		? "Failed"
		: "Done";
	let row = (
		<>
			{hasDetails && (
				<ChevronIcon aria-hidden="true" className={open ? "rotate-90" : ""} size={14} />
			)}
			<span className="min-w-0 flex-1 break-words font-mono text-text-secondary">
				{toolCopy(tool.name)}
			</span>
			<span className={tool.status === "failed" ? "text-destructive-ink" : ""}>
				{status}
			</span>
			{tool.took !== undefined && <span className="tabular-nums">{duration(tool.took)}</span>}
		</>
	);

	return (
		<li
			className="chat-tool-call"
			data-tool-status={active || disconnected ? tool.status : status.toLowerCase()}
		>
			{hasDetails
				? (
					<button
						aria-controls={contentId}
						aria-expanded={open}
						className="chat-tool-call-toggle"
						onClick={() => setOpen(value => !value)}
						type="button"
					>
						{row}
					</button>
				)
				: <div className="chat-tool-call-toggle">{row}</div>}
			{hasDetails && (
				<MotionDisclosure
					id={contentId}
					immediately={motionImmediately()}
					motion={motionContract("collapse")}
					open={open}
					surface="tool-call"
				>
					<div className="chat-tool-call-details">
						{tool.args !== undefined && (
							<div>
								<div className="chat-tool-data-label">Input</div>
								<pre>{tool.args}</pre>
							</div>
						)}
						{tool.result !== undefined && (
							<div>
								<div className="chat-tool-data-label">Result</div>
								<pre>{tool.result}</pre>
							</div>
						)}
					</div>
				</MotionDisclosure>
			)}
		</li>
	);
}

function Lattice() {
	return (
		<span aria-hidden="true" className="chat-work-lattice">
			{Array.from({ length: 9 }, (_, index) => <span key={index} />)}
		</span>
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
	let [open, setOpen] = useState(false);
	let contentId = useId();
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

	let headline = active
		? waiting ? waitingText(waiting.count) : phase!
		: disconnected && !tools.length
		? "Connection lost"
		: `Work details · ${summary.count} ${summary.count === 1 ? "action" : "actions"}`;
	let details = active ? "Details" : disconnected && tools.length
		? "Connection lost"
		: summary.toolTime > 0
		? `${duration(summary.toolTime)} tool time`
		: undefined;
	let status = summary.failures > 0
		? `${summary.failures} failed`
		: summary.interrupted > 0
		? `${summary.interrupted} interrupted`
		: undefined;
	let count = active && summary.finished > 0 ? `${summary.finished} finished` : undefined;
	let row = (
		<>
			{waiting ? <DecisionIcon aria-hidden="true" size={14} /> : active && <Lattice />}
			<span className="chat-work-headline">
				<span className="chat-work-headline-motion" key={headline}>{headline}</span>
			</span>
			{count && <span className="chat-work-meta tabular-nums">{count}</span>}
			{status && <span className="chat-work-meta text-destructive-ink tabular-nums">{status}</span>}
			{details && <span className="chat-work-meta tabular-nums">{details}</span>}
		</>
	);

	return (
		<div
			className="chat-work"
			data-tool-waiting={waiting ? "" : undefined}
			data-work-active={active}
			data-work-disconnected={disconnected}
		>
			<div className="flex min-w-0 items-center gap-2">
				{tools.length > 0
					? (
						<button
							aria-controls={contentId}
							aria-expanded={open}
							className="chat-work-toggle"
							onClick={() => setOpen(value => !value)}
							type="button"
						>
							{row}
							<MotionDisclosureIcon
								className="motion-feedback chat-work-chevron"
								closed={<ChevronIcon aria-hidden="true" size={14} />}
								open={open}
								opened={<ChevronIcon aria-hidden="true" className="rotate-90" size={14} />}
							/>
						</button>
					)
					: <div className="chat-work-static">{row}</div>}
				{decisions && first && (
					<button
						aria-label="Open decision"
						className="btn btn-sm btn-ghost shrink-0"
						onClick={() => decisions.onOpenCard(first)}
						type="button"
					>
						Open
					</button>
				)}
			</div>
			{tools.length > 0 && (
				<div id={contentId}>
					<MotionDisclosure
						id={`${contentId}-motion`}
						immediately={motionImmediately()}
						motion={motionContract("collapse")}
						open={open}
						surface="chat-tools"
					>
						<ul aria-label="Tool calls" className="chat-tool-list">
							{tools.map(tool => (
								<ToolCall active={active} disconnected={disconnected} key={tool.id} tool={tool} />
							))}
						</ul>
					</MotionDisclosure>
				</div>
			)}
		</div>
	);
}
