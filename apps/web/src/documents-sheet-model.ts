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

/** Recents earn their place only once the tree holds more than they would repeat. */
export const RECENT_DOCUMENTS = 3;

export function recentDocuments(parents: Channel[], limit = RECENT_DOCUMENTS): Channel[] {
	if (parents.length <= limit + 1) return [];
	return [...parents]
		.sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt))
		.slice(0, limit);
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
