import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { offersRetry, offlineAnnouncement, useConnectionNotice } from "@chopin/editor";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { InlineNotice } from "@chopin/visuals";

import { motionContract } from "./motion-contract";

import "./offline-notice.css";

const MOTION = motionContract("collapse");

export const OFFLINE_MESSAGE =
	"You're offline. Your changes are kept and will sync when you reconnect.";

/** The notice itself, as the design audit shows it: Retry only where the caller offers one. */
export function OfflineNoticeBody({ onRetry }: { onRetry?: () => void }) {
	return (
		<InlineNotice
			actions={onRetry
				? (
					<button className="btn btn-xs btn-outline" onClick={onRetry} type="button">
						Retry
					</button>
				)
				: undefined}
			message={OFFLINE_MESSAGE}
		/>
	);
}

/** What the owner of a document's connection has decided about its notice, and what it said. */
export type OfflineNoticeState = { open: boolean; retry: boolean; spoken: string };

/**
 * When the notice shows, whether it offers Retry, and what a screen reader hears once it is gone.
 *
 * It is held by whoever owns the connection, above wherever the notice is drawn: the page draws
 * it at the top of the document, or of Chat where Chat is all that shows, and a person switching
 * between the two during one outage must neither wait out the grace period again nor hear of the
 * outage twice. Only what is shown waits; whatever has to act on the real connection keeps reading
 * it directly.
 */
export function useOfflineNotice(lost: boolean, failures: number): OfflineNoticeState {
	let open = useConnectionNotice(lost) !== "none";
	// The action a closing notice last showed, so it does not vanish while the notice fades.
	let retry = useRef(false);
	if (open) retry.current = offersRetry(failures);
	let shown = useRef(false);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		setSpoken(offlineAnnouncement(shown.current, open));
		shown.current = open;
	}, [open]);
	return { open, retry: retry.current, spoken };
}

/**
 * The one place a document says its connection was lost: a notice at the top of its content,
 * easing open and shut without moving what is below it by more than the notice's own height. It
 * keeps no timing and says nothing aloud, so a notice that is mounted again somewhere else during
 * one outage is simply there, at once, as it was.
 *
 * A phone's panes run under its floating top bar, so the notice floats just under that bar as
 * well, and its height, as it eases, is added to the panes' top inset: it never covers the first
 * of their content.
 */
export function OfflineNotice(
	{ open, retry, onRetry }: { open: boolean; retry: boolean; onRetry: () => void },
) {
	let presence = useTransitionPresence(open ? "offline" : undefined, MOTION.closeDuration, false);
	let element = useRef<HTMLDivElement>(null);
	let mounted = presence.phase !== "closed";
	useLayoutEffect(() => {
		let notice = element.current;
		let surface = notice?.closest<HTMLElement>("[data-workspace-surface]");
		if (!notice || !surface) return;
		let reserve = () =>
			surface.style.setProperty("--phone-notice-height", `${notice.offsetHeight}px`);
		let observer = new ResizeObserver(reserve);
		observer.observe(notice);
		reserve();
		return () => {
			observer.disconnect();
			surface.style.removeProperty("--phone-notice-height");
		};
	}, [mounted]);
	let closing = presence.phase === "closing";
	return mounted
		? (
			<div
				aria-hidden={closing || undefined}
				className={`offline-notice ${MOTION.className} ${presence.className}`}
				data-offline-notice=""
				inert={closing}
				ref={element}
			>
				<div className={MOTION.contentClassName}>
					<div className="offline-notice-inset">
						<OfflineNoticeBody onRetry={retry ? onRetry : undefined} />
					</div>
				</div>
			</div>
		)
		: null;
}

/** What a screen reader is told as the notice goes: one polite word, once, in one place. */
export function OfflineAnnouncement({ spoken }: { spoken: string }) {
	return (
		<span
			aria-atomic="true"
			aria-live="polite"
			className="sr-only"
			data-offline-status=""
			role="status"
		>
			{spoken}
		</span>
	);
}
