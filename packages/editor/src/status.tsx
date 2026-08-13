/** Connection and document state, surfaced beside the plan. */

import type { Connection } from "./transport";

export type PlanStatusProps = {
	connection?: Connection;
	/** False until the shared document has arrived. */
	synced: boolean;
	/** Why it never arrived, when something went wrong opening it. */
	failed?: string;
	/** True while an agent turn owns the document. */
	busy?: boolean;
};

type Level = "hidden" | "quiet" | "notice";
type Tone = "muted" | "warn" | "error";

function describe(
	props: PlanStatusProps,
): { label: string; tone: Tone; level: Level; detail?: string } {
	if (props.connection && props.connection !== "connected") {
		return {
			label: "Reconnecting",
			tone: "warn",
			level: "notice",
			detail: "Editing resumes once connected.",
		};
	}
	if (props.failed) {
		return {
			label: "Could not open the plan",
			tone: "error",
			level: "notice",
			detail: `${props.failed}. Reloading may help.`,
		};
	}
	if (!props.synced) return { label: "Loading", tone: "muted", level: "quiet" };
	if (props.busy) return { label: "Agent is working", tone: "muted", level: "quiet" };
	return { label: "Ready", tone: "muted", level: "hidden" };
}

const TONES: Record<Tone, string> = {
	muted: "text-text-tertiary",
	warn: "text-warning-ink",
	error: "text-destructive-ink",
};

export function PlanStatus(props: PlanStatusProps) {
	let { label, tone, level, detail } = describe(props);
	return (
		<div
			aria-live="polite"
			className={`plan-status ${level === "notice" ? "animate-enter" : ""}`}
			data-level={level}
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
				<span className={level === "notice" ? "min-w-0 truncate text-text-secondary" : "sr-only"}>
					{detail}
				</span>
			)}
		</div>
	);
}
