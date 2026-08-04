/**
 * The conversation, as the room sees it.
 *
 * Shared rather than personal: every message carries who said it, and the
 * agent's tool calls are shown rather than hidden, because a plan changing
 * without visible cause is the confusing part of watching an agent work.
 *
 * Tool detail is one click away rather than always open. During a demo it is
 * noise; while building this it is the only way to see why a batch was refused.
 */

import { useEffect, useRef, useState } from "react";

import { Face } from "../face";

import type { Chat } from "@chopin/protocol";

function when(ts: number): string {
	return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TOOL_TONE: Record<Chat.ToolStatus, string> = {
	running: "text-muted-foreground",
	done: "text-muted-foreground",
	failed: "text-destructive",
};

function Activity({ activity }: { activity: Chat.Activity }) {
	let [open, setOpen] = useState(false);
	let detail = activity.args || activity.result;

	return (
		<div className="rounded-sm border border-border bg-muted/40">
			<button
				className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
					TOOL_TONE[activity.status]
				}`}
				data-press="wide"
				disabled={!detail}
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<span
					aria-hidden="true"
					className={activity.status === "running" ? "animate-pulse" : undefined}
				>
					{activity.status === "failed" ? "×" : activity.status === "running" ? "•" : "✓"}
				</span>
				<span className="font-mono">{activity.name}</span>
				{/* Tabular: this counts up as the tool runs, and the column is read down. */}
				{activity.took !== undefined && (
					<span className="ml-auto tabular-nums">{activity.took}ms</span>
				)}
			</button>

			{open && detail && (
				<div className="border-t border-border px-2 py-1.5">
					{activity.args && (
						<pre className="m-0 overflow-x-auto font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
{activity.args}
						</pre>
					)}
					{activity.result && (
						<pre className="m-0 mt-1 overflow-x-auto font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
{activity.result}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

function Entry({ entry }: { entry: Chat.Entry }) {
	if (entry.author.kind === "system") {
		return <p className="m-0 px-1 text-xs text-muted-foreground italic">{entry.text}</p>;
	}

	// Narrowed once, so the union does not have to be re-tested at each use.
	let author = entry.author;
	let agent = author.kind === "agent";

	return (
		<div className="flex gap-2">
			<div className="mt-0.5 shrink-0">
				{agent
					? (
						<span className="grid size-5 place-items-center rounded-full bg-primary text-2xs font-semibold text-primary-foreground">
							AI
						</span>
					)
					: <Face handle={author.kind === "member" ? author.handle : "?"} size={20} />}
			</div>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-baseline gap-2">
					<span className="text-xs font-semibold">
						{author.kind === "member" ? `@${author.handle}` : "Planner"}
					</span>
					<span className="text-2xs text-muted-foreground tabular-nums">{when(entry.ts)}</span>
				</div>

				{entry.text && (
					<p className="m-0 text-sm whitespace-pre-wrap">
						{entry.text}
						{entry.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
					</p>
				)}

				{entry.tools && entry.tools.length > 0 && (
					<div className="flex flex-col gap-1">
						{entry.tools.map(activity => <Activity activity={activity} key={activity.id} />)}
					</div>
				)}
			</div>
		</div>
	);
}

export function Transcript({ entries }: { entries: Chat.Entry[] }) {
	let bottom = useRef<HTMLDivElement>(null);
	let scroller = useRef<HTMLDivElement>(null);
	let pinned = useRef(true);

	// Follow the conversation, unless the reader has scrolled up to look at
	// something — in which case new output must not yank them away from it.
	useEffect(() => {
		if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
	}, [entries]);

	return (
		<div
			className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
			onScroll={event => {
				let element = event.currentTarget;
				let distance = element.scrollHeight - element.scrollTop - element.clientHeight;
				pinned.current = distance < 40;
			}}
			ref={scroller}
		>
			{entries.length === 0 && (
				<p className="m-0 text-xs text-muted-foreground">
					Ask the planner to draft something, or to read the repository first.
				</p>
			)}
			{entries.map(entry => <Entry entry={entry} key={entry.id} />)}
			<div ref={bottom} />
		</div>
	);
}
