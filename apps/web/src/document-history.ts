import { response } from "./api";

export type VersionAuthor = { login: string; avatarUrl?: string };

/** One editing session: whoever made it (absent for Chopin) and when it began and last changed. */
export type DocumentVersionSummary = {
	id: string;
	revision: number;
	startedAt: string;
	updatedAt: string;
	author?: VersionAuthor;
	/** One line on what the session did, once written. */
	summary?: string;
};

export type DocumentHistory = {
	created: { at: string; author?: VersionAuthor };
	versions: DocumentVersionSummary[];
};

export type DocumentVersionSource = {
	id: string;
	revision: number;
	updatedAt: string;
	source: string;
};

export function documentHistory(channelId: string, signal?: AbortSignal): Promise<DocumentHistory> {
	return response(`/api/channels/${encodeURIComponent(channelId)}/versions`, { signal });
}

export function documentVersion(
	channelId: string,
	versionId: string,
	signal?: AbortSignal,
): Promise<DocumentVersionSource> {
	return response(
		`/api/channels/${encodeURIComponent(channelId)}/versions/${encodeURIComponent(versionId)}`,
		{ signal },
	);
}

/** The newest sessions History asks summaries for, matching the server's bound. */
export const SUMMARIZED_SESSIONS = 20;

/**
 * Asks for summaries of the newest sessions that have none. "pending" means they are being
 * written; "unavailable" that nobody can write them now; "complete" that none were missing.
 */
export function requestHistorySummaries(
	channelId: string,
	signal?: AbortSignal,
): Promise<{ state: "pending" | "unavailable" | "complete" }> {
	return response(`/api/channels/${encodeURIComponent(channelId)}/version-summaries`, {
		method: "POST",
		signal,
	});
}

/** Whether any of the newest sessions still lacks a summary. */
export function missingSummaries(history: DocumentHistory): boolean {
	return history.versions.slice(0, SUMMARIZED_SESSIONS).some(version => !version.summary);
}

/** Restores an earlier session's prose as a new edit; decisions stay as they are now. */
export function restoreDocumentVersion(
	channelId: string,
	versionId: string,
): Promise<{ revision: number }> {
	return response(
		`/api/channels/${encodeURIComponent(channelId)}/versions/${
			encodeURIComponent(versionId)
		}/restore`,
		{ method: "POST" },
	);
}

export type HistoryEntry =
	| { kind: "edits"; at: string; version: DocumentVersionSummary; current: boolean }
	| { kind: "created"; at: string; author?: VersionAuthor };

/** Sessions newest first, each its own row, with the document's creation closing the list. */
export function historyEntries(history: DocumentHistory): HistoryEntry[] {
	let entries: HistoryEntry[] = history.versions.map((version, index) => ({
		kind: "edits",
		at: version.updatedAt,
		version,
		current: index === 0,
	}));
	entries.push({
		kind: "created",
		at: history.created.at,
		...(history.created.author ? { author: history.created.author } : {}),
	});
	return entries;
}

/** How long ago, as tersely as a row's end can hold: now, 2m, 3h, 4d, 2w, then the date. */
export function historyAge(value: string, now: Date, locale?: string): string {
	let date = new Date(value);
	let minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	let hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	let days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	let weeks = Math.floor(days / 7);
	if (weeks < 9) return `${weeks}w`;
	return historyDate(date, now, locale);
}

function historyDate(date: Date, now: Date, locale?: string): string {
	return date.toLocaleDateString(locale, {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
}

/** The exact moment, for a tooltip or the version bar: "Oct 11 at 11:17 AM". */
export function historyExact(value: string, now: Date, locale?: string): string {
	let date = new Date(value);
	let time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
	return `${historyDate(date, now, locale)} at ${time}`;
}

/**
 * Elapsed time as space before a row, in spacing units: minutes apart sit tight, weeks apart
 * breathe, up to a cap. Logarithmic, so a long gap never opens a hole in the list.
 */
export function historyGap(newer: string, older: string): number {
	let hours = Math.max(0, (new Date(newer).getTime() - new Date(older).getTime()) / 3_600_000);
	return Math.min(5, Math.round(Math.log2(hours + 1) * 0.5 * 4) / 4);
}
