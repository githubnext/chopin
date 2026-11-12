/**
 * The page's offline bar: one thin line, as Slack's is, drawn only once the room's socket has been
 * lost for a while, and gone without a word when it is back.
 *
 * Adapted from assistant-ui's standalone `ConnectionState` element (registry item
 * `elements-connection-state`, packages/ui/src/components/react/assistant-ui/elements/connection-state.tsx
 * at assistant-ui/assistant-ui f92028b4), MIT License, Copyright (c) 2026 AgentbaseAI Inc.; see
 * THIRD_PARTY_NOTICES.md. Kept: the exclusive `phase` prop (`online` renders nothing) and `onRetry`.
 * Changed: Chopin's bar, icons and roles in place of its Tailwind and lucide classes, and the shared
 * connecting dots (`ConnectingIndicator`) in place of its spinner; the resumed phase and its counter
 * are not drawn, nor is the attempt, since coming back is quiet; the button exists only where
 * there is something to retry; the root takes only an `id`. It is no live region:
 * `ConnectionAnnouncement` speaks each phase once.
 */

import { WarningIcon } from "@chopin/icons";

import { ConnectingIndicator } from "../connecting-indicator";

import { OFFLINE_MESSAGE, RECONNECTING_MESSAGE } from "./connection-phase";
import type { ConnectionPhase } from "./connection-phase";

import "./connection-state.css";

export type ConnectionStateProps = {
	phase: ConnectionPhase;
	/** The words for the phase when it has more to say than its default. */
	message?: string;
	/** Called by the Reconnect button; without it the dropped phase has no button. */
	onRetry?: () => void;
	/** It is fading out, the connection back (`useTransitionPresence`'s closing phase). */
	closing?: boolean;
	/** What a field's `aria-describedby` points at. */
	id?: string;
};

export function ConnectionState({ phase, message, onRetry, closing, id }: ConnectionStateProps) {
	if (phase === "online" || phase === "resumed") return null;
	let dropped = phase === "dropped";
	return (
		<div
			aria-hidden={closing || undefined}
			className="offline-bar"
			// Fading out, it is no longer one of the page's banners: the one that takes its place is.
			data-banner={closing ? undefined : ""}
			data-closing={closing || undefined}
			data-connection-banner=""
			data-layer="socket"
			data-offline-bar=""
			data-phase={phase}
			data-slot="connection-state"
			data-warning={dropped || undefined}
			id={id}
		>
			{dropped
				? <WarningIcon aria-hidden="true" className="offline-bar-icon" size={16} />
				: <ConnectingIndicator className="offline-bar-icon" />}
			<span className="offline-bar-text">
				{message ?? (dropped ? OFFLINE_MESSAGE : RECONNECTING_MESSAGE)}
			</span>
			{dropped && onRetry && (
				<button
					className="btn btn-xs btn-outline offline-bar-action"
					onClick={onRetry}
					type="button"
				>
					Reconnect
				</button>
			)}
		</div>
	);
}
