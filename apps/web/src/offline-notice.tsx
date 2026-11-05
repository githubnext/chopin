import { useEffect, useRef, useState } from "react";

import { offersRetry, offlineAnnouncement, useConnectionNotice } from "@chopin/editor";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { InlineNotice } from "@chopin/visuals";

import { motionContract } from "./motion-contract";

import "./offline-notice.css";

const MOTION = motionContract("collapse");

export const OFFLINE_MESSAGE =
	"You’re offline. Your changes are kept and will sync when you reconnect.";

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

/**
 * The one place a document says its connection was lost: a notice at the top of its content,
 * after a short grace period so a blip shows nothing, easing open and shut without moving what
 * is below it by more than the notice's own height. Retry joins it only once automatic
 * reconnects have failed repeatedly. Nothing follows it when the connection returns, apart from
 * one polite word for a screen reader, which heard the notice and heard the document go read-only.
 */
export function OfflineNotice(
	{ failures, lost, onRetry }: { failures: number; lost: boolean; onRetry: () => void },
) {
	let open = useConnectionNotice(lost) !== "none";
	let presence = useTransitionPresence(open ? "offline" : undefined, MOTION.closeDuration, false);
	// The action a closing notice last showed, so it does not vanish while the notice fades.
	let retry = useRef(false);
	if (open) retry.current = offersRetry(failures);
	let shown = useRef(false);
	let [spoken, setSpoken] = useState("");
	useEffect(() => {
		setSpoken(offlineAnnouncement(shown.current, open));
		shown.current = open;
	}, [open]);
	let closing = presence.phase === "closing";
	return (
		<>
			<span
				aria-atomic="true"
				aria-live="polite"
				className="sr-only"
				data-offline-status=""
				role="status"
			>
				{spoken}
			</span>
			{presence.phase !== "closed" && (
				<div
					aria-hidden={closing || undefined}
					className={`offline-notice ${MOTION.className} ${presence.className}`}
					data-offline-notice=""
					inert={closing}
				>
					<div className={MOTION.contentClassName}>
						<div className="offline-notice-inset">
							<OfflineNoticeBody onRetry={retry.current ? onRetry : undefined} />
						</div>
					</div>
				</div>
			)}
		</>
	);
}
