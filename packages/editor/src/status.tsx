/**
 * Durability and connection state, surfaced beside the plan.
 *
 * "Saved" means the canonical source reached disk, not merely that the server
 * accepted the edit — the document lives in memory, so an acknowledgement
 * alone would not survive a restart and claiming saved at that point would
 * overstate the guarantee.
 *
 * A healthy plan says nothing. The indicator exists to explain why you cannot
 * type, or that something failed; a permanent bar spending its life reading
 * "Saved" is chrome charging rent on every plan for a word nobody reads.
 * Connection and agent state are reported elsewhere too, so here they only
 * earn space because both make the editor read-only.
 */

import { useEffect, useState } from "react";

import type { Plan } from "@chopin/protocol";
import type { Connection, Transport } from "./transport";

type Durability = Plan.Status["state"];

export type PlanStatusProps = {
	wire: Transport | undefined;
	connection?: Connection;
	/** False until the shared document has arrived. */
	synced: boolean;
	/** True while an agent turn owns the document. */
	busy?: boolean;
};

/**
 * How loudly a state is worth saying.
 *
 * `quiet` is a dot: something is happening and it will pass. `notice` earns
 * words: either the plan is not safe or you cannot edit it until you act.
 */
type Level = "hidden" | "quiet" | "notice";

type Tone = "muted" | "warn" | "error";

/**
 * Saves settle on a 500ms idle timer, so an immediate dot would blink on every
 * pause in typing. Only a save that is taking a noticeable while is worth
 * showing at all.
 */
const PATIENCE = 400;

function describe(
	props: PlanStatusProps,
	durability: Durability | undefined,
	message: string | undefined,
): { label: string; tone: Tone; level: Level; detail?: string } {
	if (props.connection && props.connection !== "connected") {
		return {
			label: "Reconnecting",
			tone: "warn",
			level: "notice",
			detail: "Editing resumes once connected.",
		};
	}

	if (!props.synced) return { label: "Loading", tone: "muted", level: "quiet" };
	if (props.busy) return { label: "Agent is working", tone: "muted", level: "quiet" };

	switch (durability) {
		case "error":
			return {
				label: "Not saved",
				tone: "error",
				level: "notice",
				detail: message ?? "Retrying; keep this session open.",
			};
		case "saving":
			return { label: "Saving", tone: "muted", level: "quiet" };
		default:
			return { label: "Saved", tone: "muted", level: "hidden" };
	}
}

const TONES: Record<Tone, string> = {
	muted: "text-muted-foreground",
	warn: "text-warning",
	error: "text-destructive",
};

export function PlanStatus(props: PlanStatusProps) {
	let [durability, setDurability] = useState<Durability>();
	let [message, setMessage] = useState<string>();
	let [lingering, setLingering] = useState(false);

	useEffect(() => {
		if (!props.wire) return;
		return props.wire.on<Plan.Status>("plan:status", event => {
			setDurability(event.state);
			setMessage(event.message);
		});
	}, [props.wire]);

	useEffect(() => {
		if (durability !== "saving") {
			setLingering(false);
			return;
		}
		let timer = setTimeout(() => setLingering(true), PATIENCE);
		return () => clearTimeout(timer);
	}, [durability]);

	let { label, tone, level, detail } = describe(props, durability, message);
	if (level === "quiet" && durability === "saving" && !lingering) level = "hidden";

	return (
		<div
			className="plan-status"
			data-level={level}
			// Durability changes are informational; announcing them politely
			// keeps them out of the way of what the user is typing. The text is
			// read even where it is not drawn, so "Saved" is never lost.
			aria-live="polite"
		>
			{level !== "hidden" && (
				<span
					aria-hidden="true"
					className={`plan-status-dot ${TONES[tone]}`}
					title={level === "quiet" ? label : undefined}
				/>
			)}
			<span className={level === "notice" ? TONES[tone] : "sr-only"}>{label}</span>
			{detail && (
				<span className={level === "notice" ? "min-w-0 truncate text-muted-foreground" : "sr-only"}>
					{detail}
				</span>
			)}
		</div>
	);
}
