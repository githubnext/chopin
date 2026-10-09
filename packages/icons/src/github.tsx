/*
 * GitHub reference states, drawn on a 16px grid like the octicons they stand
 * in for, so a pull request and an issue read the same as they do on GitHub.
 *
 * Unlike the general line icons these take no caller props: their consumers
 * size and colour them from a parent, and a closed shape keeps this file free
 * of forwarded styling.
 */

import type { ReactNode } from "react";

function Glyph({ children }: { children: ReactNode }) {
	return (
		<svg aria-hidden data-nucleo-icon="" height="14" viewBox="0 0 16 16" width="14">
			<g
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			>
				{children}
			</g>
		</svg>
	);
}

export function PullRequestOpenIcon() {
	return (
		<Glyph>
			<circle cx="4" cy="3.5" r="1.75" />
			<circle cx="4" cy="12.5" r="1.75" />
			<path d="M4 5.25v5.5" />
			<circle cx="12" cy="12.5" r="1.75" />
			<path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.75" />
			<path d="M9.25 3 7.75 4.5 9.25 6" />
		</Glyph>
	);
}

export function PullRequestMergedIcon() {
	return (
		<Glyph>
			<circle cx="4" cy="3.5" r="1.75" />
			<circle cx="4" cy="12.5" r="1.75" />
			<circle cx="12" cy="9" r="1.75" />
			<path d="M4 5.25v5.5" />
			<path d="M4 5.25c0 2.25 1.75 3.75 4 3.75h2.25" />
		</Glyph>
	);
}

export function PullRequestClosedIcon() {
	return (
		<Glyph>
			<circle cx="4" cy="3.5" r="1.75" />
			<circle cx="4" cy="12.5" r="1.75" />
			<path d="M4 5.25v5.5" />
			<circle cx="12" cy="12.5" r="1.75" />
			<path d="M12 10.75V8.25" />
			<path d="m10.5 2.75 3 3m0-3-3 3" />
		</Glyph>
	);
}

export function PullRequestDraftIcon() {
	return (
		<Glyph>
			<circle cx="4" cy="3.5" r="1.75" />
			<circle cx="4" cy="12.5" r="1.75" />
			<path d="M4 5.25v5.5" />
			<circle cx="12" cy="12.5" r="1.75" />
			<circle cx="12" cy="8" fill="currentColor" r="0.5" />
			<circle cx="12" cy="4" fill="currentColor" r="0.5" />
		</Glyph>
	);
}

export function IssueOpenIcon() {
	return (
		<Glyph>
			<circle cx="8" cy="8" r="6.25" />
			<circle cx="8" cy="8" fill="currentColor" r="1" />
		</Glyph>
	);
}

export function IssueCompletedIcon() {
	return (
		<Glyph>
			<circle cx="8" cy="8" r="6.25" />
			<path d="m5.5 8.25 1.75 1.75 3.25-3.5" />
		</Glyph>
	);
}

export function IssueNotPlannedIcon() {
	return (
		<Glyph>
			<circle cx="8" cy="8" r="6.25" />
			<path d="M3.6 12.4 12.4 3.6" />
		</Glyph>
	);
}

/** A dashed ring for a reference still loading; its consumer turns it. */
export function PendingIcon() {
	return (
		<Glyph>
			<circle cx="8" cy="8" r="6.25" strokeDasharray="2 2.6" />
		</Glyph>
	);
}

/** A padlock on the same grid, for a reference Chopin cannot read. */
export function PrivateIcon() {
	return (
		<Glyph>
			<rect height="6.75" rx="1.5" width="9.5" x="3.25" y="7" />
			<path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
		</Glyph>
	);
}
