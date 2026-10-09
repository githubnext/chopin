/**
 * What a GitHub reference is, at a glance: the card a pill opens.
 *
 * State is the tinted glyph (with an accessible name), so the card carries no
 * state text, repository, field headings or activity row. Rows run title,
 * time, author, then the head branch (pull requests) or labels (issues only),
 * set slightly apart as the last row.
 */

import { useState } from "react";

import { GitHubGlyph, glyphName } from "./github-glyphs";
import { pillState } from "./github-references";

import type {
	GitHubReference,
	GitHubReferenceAuthor,
	GitHubReferenceSummary,
} from "@chopin/protocol/github-reference";
import type { GitHubPillState } from "./github-references";
import type { GitHubReferenceEntry } from "./widget-options";

const STATE_NAMES: Record<GitHubPillState, string> = {
	"pr-open": "Open pull request",
	"pr-merged": "Merged pull request",
	"pr-closed": "Closed pull request",
	"pr-draft": "Draft pull request",
	"issue-open": "Open issue",
	"issue-completed": "Completed issue",
	"issue-not-planned": "Issue closed as not planned",
	loading: "Loading",
	unavailable: "No access",
	unknown: "Status unavailable",
};

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

let format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 days ago", "yesterday", "just now". */
export function relativeTime(iso: string, now: number): string {
	let seconds = Math.round((Date.parse(iso) - now) / 1000);
	if (!Number.isFinite(seconds)) return "";
	for (let [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

/** The one moment worth showing: when it merged or closed, else its latest activity. */
export function cardTime(summary: GitHubReferenceSummary, now: number): string {
	if (summary.kind === "pull" && summary.state === "merged" && summary.mergedAt) {
		return `merged ${relativeTime(summary.mergedAt, now)}`;
	}
	if (summary.state !== "open" && summary.closedAt) {
		return `closed ${relativeTime(summary.closedAt, now)}`;
	}
	if (summary.updatedAt !== summary.createdAt) {
		return `updated ${relativeTime(summary.updatedAt, now)}`;
	}
	return `opened ${relativeTime(summary.createdAt, now)}`;
}

export type LabelTone = "neutral" | "success" | "warning" | "danger" | "brand" | "merged";

/**
 * The shared colour role nearest a GitHub label's colour.
 *
 * Labels arrive as arbitrary hex. Drawing that hex would put authored colour
 * into the interface; mapping its hue onto a semantic graphic role keeps the
 * label recognisable and the card inside the palette.
 */
export function labelTone(hex: string): LabelTone {
	let match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return "neutral";
	let value = Number.parseInt(match[1]!, 16);
	let r = (value >> 16 & 255) / 255;
	let g = (value >> 8 & 255) / 255;
	let b = (value & 255) / 255;
	let max = Math.max(r, g, b);
	let min = Math.min(r, g, b);
	let lightness = (max + min) / 2;
	let chroma = max - min;
	if (chroma < 0.15 || lightness > 0.94 || lightness < 0.08) return "neutral";
	let hue = max === r
		? ((g - b) / chroma + 6) % 6
		: max === g
		? (b - r) / chroma + 2
		: (r - g) / chroma + 4;
	let degrees = hue * 60;
	if (degrees < 15 || degrees >= 330) return "danger";
	if (degrees < 70) return "warning";
	if (degrees < 165) return "success";
	if (degrees < 240) return "brand";
	return "merged";
}

function Avatar({ author }: { author: GitHubReferenceAuthor }) {
	let [failed, setFailed] = useState(false);
	let fail = () => setFailed(true);
	return (
		<span aria-hidden className="gh-card-avatar">
			{failed || !author.avatarUrl
				? author.login.slice(0, 1).toUpperCase()
				: <img alt="" onError={fail} referrerPolicy="no-referrer" src={author.avatarUrl} />}
		</span>
	);
}

function StateGlyph(
	{ reference, state }: { reference: GitHubReference; state: GitHubPillState },
) {
	return (
		<span
			aria-label={STATE_NAMES[state]}
			className="gh-card-glyph"
			data-gh-state={state}
			role="img"
		>
			<GitHubGlyph name={glyphName(state, reference.kind)} />
		</span>
	);
}

function Skeleton() {
	return (
		<div aria-busy="true" aria-label="Loading" className="gh-card" data-loading="">
			<span className="gh-card-glyph gh-card-skeleton" />
			<div className="gh-card-body">
				<span className="gh-card-skeleton" data-line="title" />
				<span className="gh-card-skeleton" data-line="title-end" />
				<span className="gh-card-skeleton" data-line="time" />
				<span className="gh-card-person">
					<span className="gh-card-avatar gh-card-skeleton" />
					<span className="gh-card-skeleton" data-line="author" />
				</span>
				<span className="gh-card-skeleton gh-card-last" data-line="last" />
			</div>
		</div>
	);
}

export function GitHubCard(
	{ entry, now = Date.now(), reference, url }: {
		entry: GitHubReferenceEntry;
		now?: number;
		reference: GitHubReference;
		url: string;
	},
) {
	let state = pillState(entry);
	if (entry.status === "loading") return <Skeleton />;
	if (entry.status !== "ok") {
		return (
			<div className="gh-card" data-unavailable="">
				<StateGlyph reference={reference} state={state} />
				<div className="gh-card-body">
					<p className="gh-card-title">
						{reference.repository} <span className="gh-card-number">#{reference.number}</span>
					</p>
					<p className="gh-card-note">
						{entry.status === "unavailable"
							? "Chopin can’t read this repository."
							: "GitHub isn’t answering right now."}
					</p>
					<a className="gh-card-action" href={url} rel="noopener noreferrer" target="_blank">
						Open on GitHub ↗
					</a>
				</div>
			</div>
		);
	}
	let summary = entry.summary;
	let labels = summary.kind === "issue" ? summary.labels : [];
	return (
		<div className="gh-card">
			<StateGlyph reference={reference} state={state} />
			<div className="gh-card-body">
				<p className="gh-card-title">
					{summary.title} <span className="gh-card-number">#{summary.number}</span>
				</p>
				<span className="gh-card-time">{cardTime(summary, now)}</span>
				{summary.author && (
					<span className="gh-card-person">
						<Avatar author={summary.author} />
						<span className="gh-card-login">{summary.author.login}</span>
					</span>
				)}
				{summary.kind === "pull" && summary.headBranch && (
					<span className="gh-card-branch gh-card-last">
						<code>{summary.headBranch}</code>
					</span>
				)}
				{labels.length > 0 && (
					<span className="gh-card-labels gh-card-last">
						{labels.map(label => (
							<span className="gh-card-label" data-tone={labelTone(label.color)} key={label.name}>
								{label.name}
							</span>
						))}
					</span>
				)}
			</div>
		</div>
	);
}
