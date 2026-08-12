/** The shared conversation, grouped for reading rather than event delivery. */

import { useEffect, useRef, useState } from "react";
import { CaretRightIcon, ClockIcon, SignInIcon } from "@phosphor-icons/react";

import { AgentFace, Face } from "@chopin/editor";

import { MessageMarkdown } from "./markdown";
import { capitalize, displayText, duration, group, summarize, toolCopy } from "./model";

import type { Chat } from "@chopin/protocol";
import type { Group, Message } from "./model";

function when(ts: number): string {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ToolRun({ tools }: { tools: Chat.Activity[] }) {
	let [open, setOpen] = useState(false);
	let summary = summarize(tools);
	if (summary.state === "running") {
		return (
			<div className="flex h-7 items-center gap-2 py-1 text-sm text-text-quaternary">
				<ClockIcon aria-hidden="true" size={16} />
				<span className="font-mono text-text-secondary">{summary.name}</span>
				<span className="tabular-nums">{summary.completed} done</span>
			</div>
		);
	}

	return (
		<div>
			<button
				aria-expanded={open}
				className="flex h-7 items-center gap-2 bg-transparent py-1 text-sm text-text-quaternary"
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<CaretRightIcon
					aria-hidden="true"
					className={`transition-transform ${open ? "rotate-90" : ""}`}
					size={16}
				/>
				<span className="tabular-nums">
					{summary.count} {summary.count === 1 ? "tool" : "tools"}
				</span>
				{summary.failures > 0 && (
					<span className="text-destructive-ink tabular-nums">
						{summary.failures} failed
					</span>
				)}
				<span className="tabular-nums">{duration(summary.elapsed)}</span>
			</button>

			{open && (
				<ul
					aria-label="Tool calls"
					className="m-0 flex list-none flex-col pl-6 text-sm text-text-quaternary"
				>
					{tools.map(tool => (
						<li className="flex h-6 items-center gap-3" key={tool.id}>
							<span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
								{toolCopy(tool.name)}
							</span>
							{tool.status === "failed" && (
								<span className="shrink-0 text-destructive-ink">Failed</span>
							)}
							<span className="shrink-0 tabular-nums">
								{tool.took === undefined ? "—" : duration(tool.took)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function SystemEntry(
	{ arrived, item }: { arrived: boolean; item: Extract<Group, { kind: "system" }> },
) {
	return (
		<div
			className={`flex items-start gap-3 text-text-tertiary ${arrived ? "animate-enter" : ""}`}
			data-chat-system
		>
			<div className="shrink-0">
				<SignInIcon aria-hidden="true" size={20} />
			</div>
			<p className="m-0 text-sm">{displayText(item.text)}</p>
		</div>
	);
}

function MessageBody(
	{ handle, message, onWithdraw }: {
		handle: string;
		message: Message;
		onWithdraw: (id: string) => void;
	},
) {
	let text = displayText(message.text)
		|| (message.author.kind === "member" ? "Ask Planner" : "");

	return (
		<div>
			{text && (
				<div className="flex items-start gap-1">
					<div className="min-w-0 flex-1">
						<MessageMarkdown
							className={message.working ? "chat-working" : undefined}
							source={text}
						/>
						{message.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
					</div>
					{message.queued && message.author.kind === "member" && message.author.handle === handle
						&& (
							<button
								aria-label="Withdraw queued message"
								className="btn btn-icon btn-ghost -my-1 shrink-0"
								onClick={() => onWithdraw(message.id)}
								title="Withdraw"
								type="button"
							>
								×
							</button>
						)}
				</div>
			)}
			{message.tools && message.tools.length > 0 && <ToolRun tools={message.tools} />}
		</div>
	);
}

function MessageGroup(
	{ arrived, group: item, handle, onWithdraw }: {
		arrived: ReadonlySet<string>;
		group: Extract<Group, { kind: "messages" }>;
		handle: string;
		onWithdraw: (id: string) => void;
	},
) {
	let first = item.messages[0]!;
	let name = item.author.kind === "agent" ? "Planner" : capitalize(item.author.handle);

	return (
		<div
			className={`flex gap-3 ${item.queued ? "text-text-quaternary" : ""} ${
				item.messages.some(message => arrived.has(message.id)) ? "animate-enter" : ""
			}`}
			data-chat-entry
		>
			<div className={`shrink-0 ${item.queued ? "opacity-45" : ""}`}>
				{item.author.kind === "agent"
					? <AgentFace size={20} />
					: <Face handle={item.author.handle} size={20} />}
			</div>
			<div className={`flex min-w-0 flex-1 flex-col gap-1 ${item.queued ? "opacity-60" : ""}`}>
				<div className="flex items-baseline gap-1.5 text-sm">
					<span className="font-semibold">{name}</span>
					<span className="text-text-tertiary tabular-nums">
						{item.queued ? "queued" : when(first.ts!)}
					</span>
				</div>
				{item.messages.map(message => (
					<MessageBody handle={handle} key={message.id} message={message} onWithdraw={onWithdraw} />
				))}
			</div>
		</div>
	);
}

export function Transcript(
	{
		arrived,
		entries,
		handle,
		onWithdraw,
		queued,
		working,
	}: {
		arrived: ReadonlySet<string>;
		entries: Chat.Entry[];
		handle: string;
		onWithdraw: (id: string) => void;
		queued: Chat.Waiting[];
		working: boolean;
	},
) {
	let bottom = useRef<HTMLDivElement>(null);
	let pinned = useRef(true);
	let groups = group(entries, queued, working);

	useEffect(() => {
		if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
	}, [entries, queued]);

	return (
		<div
			className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4"
			onScroll={event => {
				let element = event.currentTarget;
				let distance = element.scrollHeight - element.scrollTop - element.clientHeight;
				pinned.current = distance < 40;
			}}
		>
			{groups.length === 0 && (
				<p className="m-0 text-sm text-text-quaternary">
					Ask the planner to draft something, or to read the repository first.
				</p>
			)}
			{groups.map(item =>
				item.kind === "system"
					? <SystemEntry arrived={arrived.has(item.id)} item={item} key={item.id} />
					: (
						<MessageGroup
							arrived={arrived}
							group={item}
							handle={handle}
							key={`${item.queued ? "queued" : "sent"}-${item.messages[0]!.id}`}
							onWithdraw={onWithdraw}
						/>
					)
			)}
			<div ref={bottom} />
		</div>
	);
}
