import { useId, useState } from "react";
import { ChevronIcon } from "@chopin/icons";
import { MotionDisclosure, MotionDisclosureIcon } from "@chopin/editor";

import { duration, summarize, toolCopy, workPhase } from "./model";
import { motionContract } from "../motion-contract";
import { motionImmediately } from "../motion-input";

import type { Chat } from "@chopin/protocol";

function ToolCall({ active, tool }: { active: boolean; tool: Chat.Activity }) {
	let [open, setOpen] = useState(false);
	let contentId = useId();
	let hasDetails = tool.args !== undefined || tool.result !== undefined;
	let status = tool.status === "running"
		? active ? "Running" : "Interrupted"
		: tool.status === "failed"
		? "Failed"
		: "Done";
	let row = (
		<>
			{hasDetails && (
				<ChevronIcon aria-hidden="true" className={open ? "rotate-90" : ""} size={12} />
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
		<li className="chat-tool-call" data-tool-status={active ? tool.status : status.toLowerCase()}>
			{hasDetails
				? (
					<button
						aria-controls={contentId}
						aria-expanded={open}
						className="chat-tool-call-toggle"
						onClick={() =>
							setOpen(value => !value)}
						type="button"
					>
						{row}
					</button>
				)
				: <div className="chat-tool-call-toggle">{row}</div>}
			{hasDetails && (
				<div className="chat-tool-call-details" hidden={!open} id={contentId}>
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
	{ active, responseSeen, streaming, tools }: {
		active: boolean;
		responseSeen: boolean;
		streaming: boolean;
		tools: Chat.Activity[];
	},
) {
	let [open, setOpen] = useState(false);
	let contentId = useId();
	let summary = summarize(tools, active);
	let phase = workPhase(tools, streaming, active, responseSeen);
	if (!active && !tools.length) return null;

	let headline = active
		? phase!
		: `Work details · ${summary.count} ${summary.count === 1 ? "action" : "actions"}`;
	let details = active ? "Details" : summary.toolTime > 0
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
			{active && <Lattice />}
			<span aria-live="polite" className="chat-work-headline">
				<span className="chat-work-headline-motion" key={headline}>{headline}</span>
			</span>
			{count && <span className="chat-work-meta tabular-nums">{count}</span>}
			{status && <span className="chat-work-meta text-destructive-ink tabular-nums">{status}</span>}
			{details && <span className="chat-work-meta tabular-nums">{details}</span>}
		</>
	);

	return (
		<div className="chat-work" data-work-active={active}>
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
							{tools.map(tool => <ToolCall active={active} key={tool.id} tool={tool} />)}
						</ul>
					</MotionDisclosure>
				</div>
			)}
		</div>
	);
}
