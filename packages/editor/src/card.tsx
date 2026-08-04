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
 * The header names the kind, always, so a mixed list can be scanned by what
 * things are. The footer's verb carries the status, because "accepted by" and
 * "answered by" already say it and a separate label would say it twice.
 *
 * Controls stay in each body rather than being hoisted into the footer:
 * `QuestionView` owns its submit and cancel and cannot give them up, so moving
 * the comment's would trade one asymmetry for another. Both still sit at the
 * bottom of the card.
 */

import type { ComponentProps, ReactNode } from "react";

export type SidecarCardProps = {
	/** What this is: a comment, a question. Not what has happened to it. */
	label: string;
	/** Provenance once it is settled; nothing while it is still open. */
	footer?: ReactNode;
	children: ReactNode;
	/** True while the reader is pointing at it, which also marks its prose. */
	focused?: boolean;
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
	{ children, focused, footer, label, padded = true, ...rest }:
		& SidecarCardProps
		& Omit<ComponentProps<"article">, "children">,
) {
	return (
		<article
			className={`flex flex-col overflow-hidden rounded-lg border bg-card ${
				focused ? "border-ring" : "border-border"
			}`}
			{...rest}
		>
			<header className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2">
				<span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					{label}
				</span>
			</header>

			<div className={`flex flex-col gap-2 ${padded ? "px-3 py-2.5" : ""}`}>{children}</div>

			{footer && (
				<footer className="flex items-center gap-2 border-t border-border px-3 py-2">
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
		<span className="text-2xs text-muted-foreground tabular-nums">
			{verb} by @{by}
			{stamp && ` · ${stamp}`}
		</span>
	);
}
