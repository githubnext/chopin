/**
 * The phone's loading shape: the top bar, a quiet document placeholder and the floating tab bar,
 * each where the loaded workspace puts them, so nothing moves when the real chrome arrives.
 * `index.html` carries a static copy of `PhoneSkeleton` for the first paint before JavaScript;
 * `phone-skeleton.test.ts` keeps the two identical.
 */

import { useContext, useLayoutEffect } from "react";
import { DocumentsIcon } from "@chopin/icons";

import { SidebarTrigger } from "./project-sidebar-chrome";

import type { ReactNode } from "react";

const LINES = 6;
const TABS = 4;

/** Placeholder lines in the document column: a title, then a paragraph. */
export function PhoneSkeletonPage() {
	return (
		<div aria-hidden="true" className="phone-skeleton-page">
			<span className="phone-skeleton-heading" />
			{Array.from({ length: LINES }, (_, index) => <span key={index} />)}
		</div>
	);
}

export function PhoneSkeleton({ leading }: { leading?: ReactNode }) {
	return (
		<div aria-label="Opening document" className="phone-skeleton" role="status">
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
