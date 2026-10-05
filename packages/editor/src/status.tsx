/** Connection and document state, surfaced in the document pane's header. */

import { useEffect, useId, useRef, useState } from "react";

import type { Connection } from "./transport";

export type PlanStatusProps = {
	connection?: Connection;
	/** False until the shared document has arrived. */
	synced: boolean;
	/** Why it never arrived, when something went wrong opening it. */
	failed?: string;
	/** True while an agent turn owns the document. */
	busy?: boolean;
	/** Recovers from a terminal state. Reloads the page unless the host supplies one. */
	onReload?: () => void;
};

export type StatusInput = Omit<PlanStatusProps, "onReload"> & {
	/** True once a lost connection has stayed lost long enough to call it offline. */
	stalled?: boolean;
};

/**
 * `hidden` draws nothing, `quiet` a lone dot, `notice` a dot and a secondary
 * label, `alert` a destructive label and a way to recover.
 */
export type StatusLevel = "hidden" | "quiet" | "notice" | "alert";

export type StatusDescription = {
	level: StatusLevel;
	label: string;
	detail?: string;
	reload?: boolean;
};

/** How long a lost connection stays "Reconnecting" before it reads as offline. */
export const STALL_DELAY = 5000;

export function describeStatus(input: StatusInput): StatusDescription {
	let { connection } = input;
	if (connection === "denied") {
		return {
			level: "alert",
			label: "No access",
			detail: "The server refused this connection. Reloading may help.",
			reload: true,
		};
	}
	if (connection === "closed") {
		return {
			level: "alert",
			label: "Disconnected",
			detail: "Reload to reconnect and keep editing.",
			reload: true,
		};
	}
	if (connection === "connecting" || connection === "reconnecting") {
		if (input.stalled) {
			return {
				level: "alert",
				label: "Offline",
				detail: "Editing resumes once connected. Reloading may help.",
				reload: true,
			};
		}
		// The first connection of a fresh page is ordinary loading, not a loss.
		if (connection === "connecting" && !input.synced) {
			return { level: "quiet", label: "Connecting" };
		}
		return { level: "notice", label: "Reconnecting…", detail: "Editing resumes once connected." };
	}
	if (input.failed) {
		return {
			level: "alert",
			label: "Could not open",
			detail: `${input.failed}. Reloading may help.`,
			reload: true,
		};
	}
	if (!input.synced) return { level: "quiet", label: "Loading" };
	if (input.busy) return { level: "quiet", label: "Planner is working" };
	return { level: "hidden", label: "Ready" };
}

/** True once `connection` has been lost for `STALL_DELAY` without recovering. */
export function useStalled(connection: Connection | undefined): boolean {
	let lost = connection === "connecting" || connection === "reconnecting";
	let [stalled, setStalled] = useState(false);
	useEffect(() => {
		setStalled(false);
		if (!lost) return;
		let timer = setTimeout(() => setStalled(true), STALL_DELAY);
		return () => clearTimeout(timer);
	}, [lost]);
	return lost && stalled;
}

function speaks(level: StatusLevel): boolean {
	return level === "notice" || level === "alert";
}

/**
 * What the live region says on moving from `previous` to `next`.
 *
 * Only labels that need attention are spoken, never "Ready" or loading, so
 * opening a document is silent; leaving an outage is said once.
 */
export function announcement(previous: StatusLevel, next: StatusDescription): string {
	if (speaks(next.level)) return next.label;
	if (speaks(previous)) return "Reconnected";
	return "";
}

function reloadPage() {
	location.reload();
}

export function PlanStatus({ onReload = reloadPage, ...props }: PlanStatusProps) {
	let stalled = useStalled(props.connection);
	let status = describeStatus({ ...props, stalled });
	let { label, level, detail, reload } = status;
	let detailId = useId();
	let previous = useRef<StatusLevel>(level);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		if (previous.current === level && !speaks(level)) return;
		setSpoken(announcement(previous.current, { level, label }));
		previous.current = level;
	}, [level, label]);
	return (
		<div className="plan-status" data-level={level}>
			{(level === "quiet" || level === "notice") && (
				<span
					aria-hidden="true"
					className="plan-status-dot"
					title={level === "quiet" ? label : undefined}
				/>
			)}
			{speaks(level) && (
				<span aria-hidden="true" className="plan-status-text">
					<span
						className="plan-status-label"
						data-tooltip={detail}
						data-tooltip-verbatim={detail ? "" : undefined}
					>
						{label}
					</span>
					{detail && <span className="plan-status-detail">{detail}</span>}
				</span>
			)}
			{detail && <span className="sr-only" id={detailId}>{detail}</span>}
			{reload && (
				<button
					aria-describedby={detailId}
					className="btn btn-sm btn-ghost"
					data-tooltip={detail}
					data-tooltip-detail=""
					data-tooltip-verbatim=""
					onClick={onReload}
					type="button"
				>
					Reload
				</button>
			)}
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{spoken}
			</span>
		</div>
	);
}
