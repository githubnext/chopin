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
		<div className="flex shrink-0 flex-col gap-1 px-3 py-2 hairline-t">
			<span className="text-sm font-semibold tracking-wide text-text-tertiary uppercase">
				Queued
			</span>
			{waiting.map(item => (
				<div className="animate-enter flex items-baseline gap-2 text-sm" key={item.id}>
					<span className="text-text-tertiary">@{item.handle}</span>
					<span className="min-w-0 flex-1 truncate">{item.text}</span>
					{item.handle === handle && (
						<button
							className="btn btn-icon btn-ghost shrink-0"
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
	let [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [busy, setBusy] = useState(false);
	let [turn, setTurn] = useState<string>();
	let [text, setText] = useState("");
	let input = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!wire) return;
		// History seeds `seen`; only later message frames are arrivals.
		let loaded = false;
		let seen = new Set<string>();

		// Streaming arrives as deltas against an entry already in the list, so
		// the reducer here has to be additive rather than replacing.
		let off = [
			wire.on<Wire.History>("chat:history", frame => {
				loaded = true;
				seen = new Set(frame.entries.map(entry => entry.id));
				setEntries(frame.entries);
				setArrived(new Set());
				setQueue(frame.queued);
				setBusy(frame.busy);
			}),
			wire.on<Wire.Message>("chat:message", frame => {
				if (loaded && !seen.has(frame.entry.id)) {
					setArrived(current => new Set(current).add(frame.entry.id));
				}
				seen.add(frame.entry.id);
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
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center gap-2 px-3 py-2 hairline-b">
				<span className="text-sm font-semibold tracking-wide text-text-tertiary uppercase">
					Planner
				</span>
				{busy && (
					<span className="text-sm text-text-tertiary">
						working{turn && ` on @${turn}'s message`}
					</span>
				)}
				{busy && (
					<button
						className="btn btn-sm btn-secondary ml-auto"
						onClick={() => wire?.send("chat:abort")}
						type="button"
					>
						Stop
					</button>
				)}
			</header>

			{!!waiting && waiting > 0 && (
				<button
					className="btn btn-sm btn-ghost animate-enter flex w-full shrink-0 justify-start gap-2 text-left hairline-b"
					data-press="wide"
					onClick={() => onReveal?.("")}
					type="button"
				>
					<span className="text-warning-ink">●</span>
					<span>
						{waiting === 1 ? "A question is waiting" : `${waiting} questions are waiting`}
					</span>
					<span className="ml-auto text-text-secondary">Answer →</span>
				</button>
			)}

			<Transcript arrived={arrived} entries={entries} />

			<Queued
				handle={handle}
				onWithdraw={id => wire?.send("chat:unqueue", { id })}
				waiting={queue}
			/>

			<div className="flex shrink-0 flex-col gap-1 p-2 hairline-t">
				<textarea
					className="w-full resize-none rounded-md control-edge bg-page px-2 py-1.5 text-sm focus-visible:border-brand disabled:opacity-50"
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

				<div className="flex items-baseline gap-2 px-1 text-sm">
					{asking
						? (
							<span className="text-brand">
								→ planner{busy && ", after the current turn"}
							</span>
						)
						: (
							<span className="text-text-secondary">
								room only — the planner will see it on its next turn
							</span>
						)}
					<button
						className="btn btn-sm btn-ghost ml-auto"
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
