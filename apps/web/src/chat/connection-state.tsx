/**
 * The Chat's connection banner: the room's socket, the document catching up on it, and the
 * Planner's own connection, one phase at a time.
 *
 * Adapted from assistant-ui's standalone `ConnectionState` element (registry item
 * `elements-connection-state`, packages/ui/src/components/react/assistant-ui/elements/connection-state.tsx
 * at assistant-ui/assistant-ui f92028b4), MIT License, Copyright (c) 2026 AgentbaseAI Inc.; see
 * THIRD_PARTY_NOTICES.md. Kept: the exclusive `phase` prop (`online` renders nothing), `attempt`,
 * `onRetry`, one entrance and no exit. Changed: Chopin's strip, icons and roles in place of its
 * Tailwind and lucide classes; the resumed counter is words (`caught`); the message can be the
 * machine's own words; the button exists only where there is something to retry; the root takes
 * only an `id`. It is no live region: `ConnectionAnnouncement` speaks each phase once.
 */

import { CheckIcon, LoaderIcon, WarningIcon } from "@chopin/icons";

import { OFFLINE_MESSAGE } from "./connection-phase";
import type { ConnectionPhase } from "./connection-phase";

export type ConnectionStateProps = {
	phase: ConnectionPhase;
	/** The attempt in flight, shown beside the reconnecting words when set. */
	attempt?: number;
	/** The words for the phase when it has more to say than its default. */
	message?: string;
	/** More than the words say, one line each, exactly as supplied. */
	detail?: readonly string[];
	/** What was caught up on, shown beside the resumed words when set. */
	caught?: string;
	/** A link for where to go about it, in the accent. */
	link?: { label: string; href: string };
	/** Called by the Reconnect button; without it the dropped phase has no button. */
	onRetry?: () => void;
	/** The button's label where it is not Reconnect. */
	retryLabel?: string;
	/** Which layer the phase speaks of, for tests and styling. */
	layer?: string;
	/** What a field's `aria-describedby` points at. */
	id?: string;
};

const DEFAULT_MESSAGE: Record<Exclude<ConnectionPhase, "online">, string> = {
	dropped: OFFLINE_MESSAGE,
	reconnecting: "Reconnecting. Your changes are kept.",
	resumed: "Back online.",
};

export function ConnectionState(
	{
		phase,
		attempt,
		message,
		detail,
		caught,
		link,
		onRetry,
		retryLabel,
		layer,
		id,
	}: ConnectionStateProps,
) {
	if (phase === "online") return null;
	let words = message ?? DEFAULT_MESSAGE[phase];
	return (
		<div
			className="composer-notice"
			data-banner=""
			data-connection-banner=""
			data-layer={layer}
			data-phase={phase}
			data-slot="connection-state"
			data-success={phase === "resumed" || undefined}
			data-warning={phase === "dropped" || undefined}
			id={id}
		>
			{phase === "dropped"
				? <WarningIcon className="composer-notice-icon icon-first-line" size={16} />
				: phase === "resumed"
				? <CheckIcon className="composer-notice-icon icon-first-line" size={16} />
				: (
					<LoaderIcon
						className="composer-notice-icon composer-notice-spin icon-first-line"
						size={16}
					/>
				)}
			<span>
				{words}
				{detail?.map((line, index) => (
					<span className="composer-notice-line" key={index}>{line}</span>
				))}
				{link && (
					<>
						{" "}
						<a className="composer-notice-link" href={link.href} rel="noreferrer" target="_blank">
							{link.label}
						</a>
					</>
				)}
			</span>
			{phase === "reconnecting" && attempt !== undefined && (
				<span className="composer-notice-count" data-connection-attempt="">attempt {attempt}</span>
			)}
			{phase === "resumed" && caught && (
				<span className="composer-notice-count" data-connection-caught="">{caught}</span>
			)}
			{phase === "dropped" && onRetry && (
				<button className="btn btn-xs btn-outline" onClick={onRetry} type="button">
					{retryLabel ?? "Reconnect"}
				</button>
			)}
		</div>
	);
}
