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

import { addressed } from "@chopin/protocol/address";

import { Transcript } from "./transcript";
import { activeTurn } from "./model";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
	wire: Socket | undefined;
	handle: string;
	connected: boolean;
};

export function Chat({ connected, handle, wire }: ChatProps) {
	let [entries, setEntries] = useState<Wire.Entry[]>([]);
	let [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [busy, setBusy] = useState(false);
	let [turn, setTurn] = useState<Wire.Turn>();
	let [text, setText] = useState("");
	let synchronized = useRef<Socket | undefined>(undefined);

	// A socket is connected before its fresh history arrives. Do not let a
	// previous socket's transient turn project into that gap.
	if (!connected) synchronized.current = undefined;

	useEffect(() => {
		if (!wire) return;
		// History seeds `seen`; only later message frames are arrivals.
		let loaded = false;
		let seen = new Set<string>();
		let response = (agent: boolean, value: string) => {
			if (!agent || !value.trim()) return;
			setTurn(current => current && !current.responded ? { ...current, responded: true } : current);
		};

		// Streaming arrives as deltas against an entry already in the list, so
		// the reducer here has to be additive rather than replacing.
		let off = [
			wire.on<Wire.History>("chat:history", frame => {
				loaded = true;
				synchronized.current = wire;
				seen = new Set(frame.entries.map(entry => entry.id));
				setEntries(frame.entries);
				setArrived(new Set());
				setQueue(frame.queued);
				setBusy(frame.busy);
				setTurn(activeTurn(frame.turn));
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
				response(frame.entry.author.kind === "agent", frame.entry.text);
			}),
			wire.on<Wire.Delta>("chat:delta", frame => {
				setEntries(current =>
					current.map(entry =>
						entry.id === frame.id ? { ...entry, text: entry.text + frame.text } : entry
					)
				);
				response(true, frame.text);
			}),
			wire.on<Wire.Tool>("chat:tool", frame => {
				setEntries(current => {
					let index = current.findIndex(entry => entry.id === frame.entry);
					if (index < 0) return current;
					let next = [...current];
					let entry = next[index]!;
					let tools = entry.tools ?? [];
					let existing = tools.findIndex(item => item.id === frame.activity.id);
					next[index] = {
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
				setTurn(activeTurn(frame.turn));
			}),
			wire.on<Wire.Queue>("chat:queue", frame => setQueue(frame.waiting)),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire]);

	let submit = (to: Wire.Destination) => {
		let value = text.trim();
		if (!value || !wire || !connected) return;
		wire.send("chat:send", { text: value, to });
		setText("");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Transcript
				arrived={arrived}
				entries={entries}
				handle={handle}
				onWithdraw={id => wire?.send("chat:unqueue", { id })}
				queued={queue}
				working={connected && synchronized.current === wire && turn
					? turn
					: undefined}
			/>

			<div className="flex shrink-0 flex-col gap-2 px-4 pb-4">
				<textarea
					className="field h-18 w-full resize-none px-2.5 py-1.5 text-sm"
					disabled={!connected}
					onChange={event => setText(event.target.value)}
					onKeyDown={event => {
						// Enter sends; a newline needs a modifier, as everywhere else.
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						submit(addressed(text) ? "planner" : "room");
					}}
					placeholder="Say something…"
					rows={3}
					value={text}
				/>

				<div className="flex items-center gap-2">
					{busy && (
						<button
							className="btn btn-md btn-secondary"
							onClick={() => wire?.send("chat:abort")}
							type="button"
						>
							Stop
						</button>
					)}
					<div className="ml-auto flex items-center gap-2">
						<button
							className="btn btn-md btn-secondary"
							disabled={!connected || !text.trim()}
							onClick={() => submit("room")}
							type="button"
						>
							Send to room
						</button>
						<button
							className="btn btn-md btn-primary"
							disabled={!connected || !text.trim()}
							onClick={() => submit("planner")}
							type="button"
						>
							Ask Planner
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
