import { useLayoutEffect, useRef } from "react";

import { ConnectionBannerView } from "./chat/connection-banner";
import { offlineBar } from "./chat/connection-phase";
import type { ConnectionView } from "./chat/connection-phase";

import "./document-banner.css";

/**
 * Whether the document draws this view: only the offline bar, the room's own socket lost for a
 * while. Catching up and coming back are quiet, and the Planner's machine is never drawn here.
 */
export function documentTells(view: ConnectionView): boolean {
	return offlineBar(view) !== undefined;
}

/**
 * The offline bar where Chat is not on screen: at the top of the document's content, or of the page
 * above its panes (see `pageNoticePlace`). It is the same bar as the one over Chat's transcript,
 * and the page draws one or the other, so a lost connection is never told twice. It keeps no timing
 * and says nothing aloud: the page holds the phase machine above both places and speaks from one
 * polite region (`ConnectionAnnouncement`), so a bar mounted again somewhere else during one outage
 * is simply there.
 *
 * A phone's panes run under its floating top bar, so the banner floats just under that bar as
 * well, and its height is added to the panes' top inset: it never covers the first of their
 * content.
 */
export function DocumentBanner(
	{ view, onRetry }: { view: ConnectionView; onRetry: (() => void) | undefined },
) {
	let element = useRef<HTMLDivElement>(null);
	let told = documentTells(view);
	useLayoutEffect(() => {
		let banner = element.current;
		let surface = banner?.closest<HTMLElement>("[data-workspace-surface]");
		if (!banner || !surface) return;
		let reserve = () =>
			surface.style.setProperty("--phone-notice-height", `${banner.offsetHeight}px`);
		let observer = new ResizeObserver(reserve);
		observer.observe(banner);
		reserve();
		return () => {
			observer.disconnect();
			surface.style.removeProperty("--phone-notice-height");
		};
	}, [told]);
	return told
		? (
			<div className="document-banner" data-document-banner="" ref={element}>
				<div className="document-banner-inset">
					<ConnectionBannerView onRetry={onRetry} view={view} />
				</div>
			</div>
		)
		: null;
}
