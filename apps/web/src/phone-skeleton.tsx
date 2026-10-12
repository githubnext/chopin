/**
 * The phone's loading shape: the top bar, a quiet document placeholder and the floating tab bar,
 * each where the loaded workspace puts them, so nothing moves when the real chrome arrives.
 * `index.html` carries a static copy of `PhoneSkeleton` for the first paint before JavaScript;
 * `phone-skeleton.test.tsx` keeps the two identical.
 */

import { useContext, useLayoutEffect, useRef } from "react";
import { DocumentsIcon } from "@chopin/icons";

import { SidebarTrigger } from "./project-sidebar-chrome";

import type { ReactNode, Ref } from "react";

const LINES = 6;
const TABS = 4;

/** Placeholder lines in the document column: a title, then a paragraph. */
export function PhoneSkeletonPage({ ref }: { ref?: Ref<HTMLDivElement> }) {
	return (
		<div aria-hidden="true" className="phone-skeleton-page" ref={ref}>
			<span className="phone-skeleton-heading" />
			{Array.from({ length: LINES }, (_, index) => <span key={index} />)}
		</div>
	);
}

/**
 * The same lines inside a mounted document column while its document has not yet arrived. The
 * column belongs to the editor, so the busy state is set on it from here for as long as they show.
 */
export function DocumentSkeleton() {
	let lines = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		let column = lines.current?.closest("[data-plan-scroll]");
		column?.setAttribute("aria-busy", "true");
		return () => column?.removeAttribute("aria-busy");
	}, []);
	return <PhoneSkeletonPage ref={lines} />;
}

export function PhoneSkeleton({ leading }: { leading?: ReactNode }) {
	return (
		<div className="phone-skeleton">
			<p className="sr-only" role="status">Opening document…</p>
			<div className="phone-skeleton-top">
				<span className="phone-skeleton-slot">
					{leading ?? (
						<span aria-hidden="true" className="phone-skeleton-icon">
							<DocumentsIcon />
						</span>
					)}
				</span>
			</div>
			<PhoneSkeletonPage />
			<div aria-hidden="true" className="phone-skeleton-tabs">
				<span className="phone-skeleton-bar">
					{Array.from({ length: TABS }, (_, index) => <span key={index} />)}
				</span>
				<span className="phone-skeleton-action" />
			</div>
		</div>
	);
}

/** Inside the navigation shell the bar holds the real Documents button, as the loaded bar does. */
export function PhoneDocumentSkeleton() {
	let trigger = useContext(SidebarTrigger);
	let claim = trigger?.claim;
	useLayoutEffect(() => claim?.(), [claim]);
	return (
		<PhoneSkeleton
			leading={trigger && (
				<button
					aria-haspopup="dialog"
					aria-label="Documents"
					className="btn btn-icon btn-ghost"
					onClick={trigger.onExpand}
					ref={trigger.buttonRef}
					type="button"
				>
					<DocumentsIcon />
				</button>
			)}
		/>
	);
}
