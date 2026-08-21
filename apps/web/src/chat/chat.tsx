/**
 * The chat pane.
 *
 * Drives the agent, and shows what it is doing. The composer stays live while
 * a turn runs — a turn owns the plan, not the conversation — and anything sent
 * to the agent meanwhile is queued in order, with its author's name on it, so
 * nobody is silenced because a colleague prompted first.
 *
 * The agent only acts when addressed, so one Send action can follow the
 * message's own signal rather than asking its author to select a destination.
 */

import { useEffect, useRef, useState } from "react";

import { addressed, MENTION } from "@chopin/protocol/address";

import { Transcript } from "./transcript";
import plannerStop from "../assets/icons/planner-stop.svg";
import send from "../assets/icons/send-arrow-up.svg";

import type { Chat as Wire } from "@chopin/protocol";
import type { Wire as Socket } from "../wire";

export type ChatProps = {
	wire: Socket | undefined;
	handle: string;
	connected: boolean;
	/** Hosted mode keeps the shared conversation while repository-scoped agent work is disabled. */
	agent?: boolean;
	active?: boolean;
	onActivity?: (event: { type: "message" | "working"; busy: boolean }) => void;
};

export function Chat(
	{ active = true, agent = true, connected, handle, onActivity, wire }: ChatProps,
) {
	let [entries, setEntries] = useState<Wire.Entry[]>([]);
	let [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
	let [queue, setQueue] = useState<Wire.Waiting[]>([]);
	let [busy, setBusy] = useState(false);
	let [turn, setTurn] = useState<Wire.Turn>();
	let [text, setText] = useState("");
	let synchronized = useRef<Socket | undefined>(undefined);
	let activity = useRef(onActivity);
	let reportedBusy = useRef(false);
	activity.current = onActivity;

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
				reportedBusy.current = frame.busy;
				setTurn(frame.turn);
				// History is not unread, but a turn already in progress still needs
				// a signal outside a closed Conversation destination.
				activity.current?.({ type: "working", busy: frame.busy });
			}),
			wire.on<Wire.Message>("chat:message", frame => {
				if (loaded && !seen.has(frame.entry.id)) {
					setArrived(current => new Set(current).add(frame.entry.id));
					activity.current?.({ type: "message", busy: reportedBusy.current });
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
				if (loaded && reportedBusy.current !== frame.busy) {
					activity.current?.({ type: "working", busy: frame.busy });
				}
				reportedBusy.current = frame.busy;
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
		wire.send("chat:send", { text: value, to: agent && addressed(text) ? "planner" : "room" });
		setText("");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Transcript
				active={active}
				arrived={arrived}
				entries={entries}
				handle={handle}
				onWithdraw={id => wire?.send("chat:unqueue", { id })}
				queued={queue}
				working={connected && synchronized.current === wire && turn
					? turn
					: undefined}
			/>

			<div className="conversation-composer shrink-0 px-2.5 pb-2.5">
				<div className="field flex flex-col">
					<textarea
						className="min-h-0 flex-1 w-full resize-none bg-transparent px-4 py-3 text-[14px]"
						disabled={!connected}
						onChange={event => setText(event.target.value)}
						onKeyDown={event => {
							// Enter sends; a newline needs a modifier, as everywhere else.
							if (event.key !== "Enter" || event.shiftKey) return;
							event.preventDefault();
							submit();
						}}
						placeholder={`Use ${MENTION} to ask Chopin`}
						rows={3}
						value={text}
					/>

					<div className="flex items-center justify-end gap-1 px-2 pb-2">
						{agent && busy && (
							<button
								aria-label="Stop Planner"
								className="btn btn-icon btn-secondary"
								onClick={() => wire?.send("chat:abort")}
								title="Stop Planner"
								type="button"
							>
								<img alt="" className="size-[18px]" src={plannerStop} />
							</button>
						)}
						<button
							aria-label="Send message"
							className="conversation-send-button btn btn-icon btn-primary rounded-full"
							disabled={!connected || !text.trim()}
							onClick={submit}
							title="Send message"
							type="button"
						>
							<img alt="" className="conversation-send-icon size-[14px]" src={send} />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
