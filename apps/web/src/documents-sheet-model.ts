import type { Channel } from "./api";

export function documentGroups(
	channels: Channel[],
	archiveMode: boolean,
): Array<{ parent: Channel; children: Channel[] }> {
	let parents = channels.filter(channel =>
		channel.parentChannelId === undefined
		&& (archiveMode ? channel.archivedAt !== undefined : channel.archivedAt === undefined)
	);
	let parentIds = new Set(parents.map(channel => channel.id));
	let children = new Map<string, Channel[]>();
	for (let channel of channels) {
		if (!channel.parentChannelId || !parentIds.has(channel.parentChannelId)) continue;
		let nested = children.get(channel.parentChannelId) ?? [];
		nested.push(channel);
		children.set(channel.parentChannelId, nested);
	}
	return parents.map(parent => ({ parent, children: children.get(parent.id) ?? [] }));
}

export type DocumentGroup = ReturnType<typeof documentGroups>[number];

/**
 * Narrows a tree to documents whose titles contain the query. A matching parent keeps its whole
 * group; otherwise a parent stays only to hold the children that match.
 */
export function filterDocumentGroups(groups: DocumentGroup[], query: string): DocumentGroup[] {
	let needle = query.trim().toLocaleLowerCase();
	if (!needle) return groups;
	let matches = (channel: Channel) => channel.title.toLocaleLowerCase().includes(needle);
	return groups.flatMap(group => {
		if (matches(group.parent)) return [group];
		let children = group.children.filter(matches);
		return children.length > 0 ? [{ parent: group.parent, children }] : [];
	});
}

const RECENT_LIMIT = 8;

/** Storage access itself throws where site data is blocked. */
export function browserStorage(): Storage | undefined {
	try {
		return localStorage;
	} catch {
		return undefined;
	}
}

function recentKey(userId: string): string {
	return `chopin:recent-documents:${userId}`;
}

/** Each project's documents this browser's user opened, newest first. */
export function readRecentIds(
	storage: Pick<Storage, "getItem"> | undefined,
	userId: string,
	repositoryId: string,
): string[] {
	try {
		let value: unknown = JSON.parse(storage?.getItem(recentKey(userId)) ?? "{}");
		let ids = value && typeof value === "object"
			? (value as Record<string, unknown>)[repositoryId]
			: undefined;
		return Array.isArray(ids) ? ids.filter(id => typeof id === "string") : [];
	} catch {
		return [];
	}
}

export function rememberOpened(
	storage: Pick<Storage, "getItem" | "setItem"> | undefined,
	userId: string,
	repositoryId: string,
	documentId: string,
): void {
	try {
		let all: Record<string, unknown> = JSON.parse(storage?.getItem(recentKey(userId)) ?? "{}");
		let ids = readRecentIds(storage, userId, repositoryId).filter(id => id !== documentId);
		all[repositoryId] = [documentId, ...ids].slice(0, RECENT_LIMIT);
		storage?.setItem(recentKey(userId), JSON.stringify(all));
	} catch {
		// Recents are a convenience; private modes and full storage simply go without.
	}
}

/**
 * Recently opened documents other than the one on screen, still active in the catalogue.
 * One alone would only repeat the tree, so recents show from two.
 */
export function recentDocuments(
	ids: string[],
	channels: Channel[],
	currentId: string | undefined,
	limit = 3,
): Channel[] {
	let known = new Map(channels.map(channel => [channel.id, channel]));
	let recent = ids.filter(id => id !== currentId)
		.map(id => known.get(id))
		.filter((channel): channel is Channel => channel !== undefined && !channel.archivedAt)
		.slice(0, limit);
	return recent.length >= 2 ? recent : [];
}

export function editedLabel(updatedAt: string, now: number, locale?: string): string {
	let then = Date.parse(updatedAt);
	if (!Number.isFinite(then)) return "";
	let minutes = Math.floor(Math.max(0, now - then) / 60_000);
	if (minutes < 1) return "Edited just now";
	if (minutes < 60) return `Edited ${minutes} min ago`;
	let hours = Math.floor(minutes / 60);
	if (hours < 24) return `Edited ${hours} hr ago`;
	let date = new Date(then);
	let today = new Date(now);
	let days = Math.round(
		(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
			- new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000,
	);
	if (days <= 1) return "Edited yesterday";
	if (days < 7) {
		return `Edited ${date.toLocaleDateString(locale, { weekday: "long" })}`;
	}
	return `Edited ${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}
