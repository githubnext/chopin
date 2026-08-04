/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the conversation — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 *
 * The agent only acts when addressed, so the composer says where a message is
 * going before it goes. The failure worth designing out is typing into what
 * looks like a prompt and being met with silence.
 */

import { useEffect, useRef, useState } from "react";

import { addressed, MENTION } from "@chopin/protocol/address";

import { Transcript } from "./transcript";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
	wire: Socket | undefined;
	handle: string;
	connected: boolean;
	/** Brings a questionnaire into view in the decisions pane. */
	onReveal?: (widget: string) => void;
	/** Open questions, so the pane can point at the one that is blocking. */
	waiting?: number;
};

function Queued(
	{ handle, onWithdraw, waiting }: {
		handle: string;
		waiting: Wire.Waiting[];
		onWithdraw: (id: string) => void;
	},
) {
	if (waiting.length === 0) return null;

	return (
		<div className="flex shrink-0 flex-col gap-1 border-t border-border px-3 py-2">
			<span className="text-[0.625rem] font-semibold tracking-wide text-muted-foreground uppercase">
				Queued
			</span>
			{waiting.map(item => (
				<div className="flex items-baseline gap-2 text-xs" key={item.id}>
					<span className="text-muted-foreground">@{item.handle}</span>
					<span className="min-w-0 flex-1 truncate">{item.text}</span>
					{item.handle === handle && (
						<button
							className="shrink-0 text-muted-foreground hover:text-destructive"
							onClick={() => onWithdraw(item.id)}
							title="Withdraw"
							type="button"
						>
							×
						</button>
					)}
				</div>
			))}
		</div>
	);
}

export function Chat({ connected, handle, onReveal, waiting, wire }: ChatProps) {
	let [entries, setEntries] = useState<Wire.Entry[]>([]);
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [busy, setBusy] = useState(false);
	let [turn, setTurn] = useState<string>();
	let [text, setText] = useState("");
	let input = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!wire) return;

		// Streaming arrives as deltas against an entry already in the list, so
		// the reducer here has to be additive rather than replacing.
		let off = [
			wire.on<Wire.History>("chat:history", frame => {
				setEntries(frame.entries);
				setQueue(frame.queued);
				setBusy(frame.busy);
			}),
			wire.on<Wire.Message>("chat:message", frame => {
				setEntries(current => {
					let index = current.findIndex(entry => entry.id === frame.entry.id);
					if (index < 0) return [...current, frame.entry];
					let next = [...current];
					next[index] = frame.entry;
					return next;
				});
			}),
			wire.on<Wire.Delta>("chat:delta", frame => {
				setEntries(current =>
					current.map(entry =>
						entry.id === frame.id ? { ...entry, text: entry.text + frame.text } : entry
					)
				);
			}),
			wire.on<Wire.Tool>("chat:tool", frame => {
				setEntries(current => {
					let index = current.findIndex(entry => entry.id === frame.entry);
					let target = index < 0 ? current.length - 1 : index;
					if (target < 0) return current;
					let next = [...current];
					let entry = next[target]!;
					let tools = entry.tools ?? [];
					let existing = tools.findIndex(item => item.id === frame.activity.id);
					next[target] = {
						...entry,
						tools: existing < 0
							? [...tools, frame.activity]
							: tools.map((item, at) => at === existing ? { ...item, ...frame.activity } : item),
					};
					return next;
				});
			}),
			wire.on<Wire.State>("chat:state", frame => {
				setBusy(frame.busy);
				setTurn(frame.turn);
			}),
			wire.on<Wire.Queue>("chat:queue", frame => setQueue(frame.waiting)),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire]);

	let submit = () => {
		let value = text.trim();
		if (!value || !wire || !connected) return;
		wire.send("chat:send", { text: value });
		setText("");
	};

	let asking = addressed(text);

	return (
		<div className="flex h-full min-h-0 flex-col border-r border-border">
			<header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					Planner
				</span>
				{busy && (
					<span className="text-xs text-muted-foreground">
						working{turn && ` on @${turn}'s message`}
					</span>
				)}
				{busy && (
					<button
						className="ml-auto rounded-sm border border-border px-2 py-0.5 text-xs hover:bg-muted"
						onClick={() => wire?.send("chat:abort")}
						type="button"
					>
						Stop
					</button>
				)}
			</header>

			{!!waiting && waiting > 0 && (
				<button
					className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-3 py-2 text-left text-xs hover:bg-muted"
					onClick={() => onReveal?.("")}
					type="button"
				>
					<span className="text-warning">●</span>
					<span>
						{waiting === 1 ? "A question is waiting" : `${waiting} questions are waiting`}
					</span>
					<span className="ml-auto text-muted-foreground">Answer →</span>
				</button>
			)}

			<Transcript entries={entries} />

			<Queued
				handle={handle}
				onWithdraw={id => wire?.send("chat:unqueue", { id })}
				waiting={queue}
			/>

			<div className="flex shrink-0 flex-col gap-1 border-t border-border p-2">
				<textarea
					className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring disabled:opacity-50"
					disabled={!connected}
					onChange={event => setText(event.target.value)}
					onKeyDown={event => {
						// Enter sends; a newline needs a modifier, as everywhere else.
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						submit();
					}}
					placeholder={`Talk to the room, or mention ${MENTION} to ask the planner…`}
					ref={input}
					rows={3}
					value={text}
				/>

				<div className="flex items-baseline gap-2 px-1 text-[0.625rem]">
					{asking
						? (
							<span className="text-primary">
								→ planner{busy && ", after the current turn"}
							</span>
						)
						: (
							<span className="text-muted-foreground">
								room only — the planner will see it on its next turn
							</span>
						)}
					<button
						className="ml-auto text-muted-foreground hover:text-foreground"
						onClick={() => {
							setText(current => (addressed(current) ? current : `${MENTION} ${current}`.trim()));
							input.current?.focus();
						}}
						type="button"
					>
						{asking ? "" : `+ ${MENTION}`}
					</button>
				</div>
			</div>
		</div>
	);
}
