/**
 * The shape every sidecar card has.
 *
 * A question the room answered and a comment the room accepted are the same
 * kind of thing — something settled, with a record of who settled it — and used
 * to look nothing alike: one had a header and no provenance, the other
 * provenance and no header. Two components rendering similar chrome by
 * convention is how that happens, so the chrome lives here instead and neither
 * card draws its own.
 *
 * The body distinguishes comments from questions visually; the card keeps its
 * kind as an accessible name. Settled provenance sits above the body, leaving
 * the footer for actions that still apply.
 *
 * Controls stay in each body rather than being hoisted into the footer:
 * `QuestionView` owns its submit and cancel and cannot give them up, so moving
 * the comment's would trade one asymmetry for another. Both still sit at the
 * bottom of the card.
 */

import type { ComponentProps, ReactNode } from "react";

export type SidecarCardProps = {
	/** The card kind, retained as its programmatic name. */
	label: string;
	/** An action and the reason it remains available. */
	footer?: ReactNode;
	children: ReactNode;
	/** True while the reader is pointing at it, which also marks its prose. */
	focused?: boolean;
	/** True once the comment or question can no longer be acted on. */
	settled?: boolean;
	/** Who settled the card and when. */
	status?: ReactNode;
	/**
	 * False when the body already insets itself.
	 *
	 * `QuestionView` pads its own content and belongs to another package, so
	 * the shell would otherwise inset it twice. The escape hatch is narrower
	 * than letting each card space itself, which is how they drifted apart.
	 */
	padded?: boolean;
};

export function SidecarCard(
	{ children, focused, footer, label, padded = true, settled, status, ...rest }:
		& SidecarCardProps
		& Omit<ComponentProps<"article">, "children">,
) {
	let surface = settled ? "bg-inset" : "bg-page shadow-resting";

	return (
		<article
			aria-label={label}
			className={`flex flex-col overflow-hidden rounded-lg ring-hairline ${surface} ${
				focused ? "bg-selected" : ""
			}`}
			data-focus-boundary=""
			{...rest}
		>
			{status && <div className="flex justify-end px-3 pt-2.5 empty:hidden">{status}</div>}

			<div className={`flex flex-col gap-2 ${padded ? "px-3 py-2.5" : ""}`}>{children}</div>

			{footer && (
				<footer className="flex items-center gap-2 px-3 py-2">
					{footer}
				</footer>
			)}
		</article>
	);
}

/**
 * When something happened, at the precision a reader cares about.
 *
 * Takes either shape the two records keep it in: Unix seconds for a comment
 * thread, an ISO string for a questionnaire read back out of the plan.
 */
export function when(at: number | string): string {
	let date = typeof at === "number" ? new Date(at * 1_000) : new Date(at);
	if (Number.isNaN(date.getTime())) return "";

	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export type ProvenanceProps = {
	/** What was done: accepted, answered. The status, said as a verb. */
	verb: string;
	by?: string;
	at?: number | string;
};

/** Who settled something, and when — as much of it as was recorded. */
export function Provenance({ at, by, verb }: ProvenanceProps) {
	if (!by) return null;
	let stamp = at === undefined ? "" : when(at);

	return (
		<span className="text-sm text-text-tertiary tabular-nums">
			{verb} by @{by}
			{stamp && ` · ${stamp}`}
		</span>
	);
}
