/**
 * A message's references as the sidecar keeps them.
 *
 * A server before the pointers of the composer (a command, a heading, a Decision, a file of the
 * repository) restores a stored transcript strictly: every reference must be a document or a
 * research card, or it refuses the whole sidecar and the document cannot be opened. So a pointer is
 * stored under a key of its own, which that server ignores as it ignores every key it does not
 * know, and its message reads there as the words it was written in. A server that knows pointers
 * merges them back, by where each begins in the text: references are disjoint and in order, so the
 * list it restores is the list that was stored, exactly.
 */

import type { Chat as Wire } from "@chopin/protocol";
import type { JsonValue } from "../storage/model";

/** The kinds a server without pointers restores. */
const RESTORED_BY_OLDER_SERVERS = new Set<string>(["document", "research"]);

/** The entries as the sidecar stores them: each pointer moved from `references` to `pointers`. */
export function entriesForStorage(entries: readonly Wire.Entry[]): Wire.Entry[] {
	return entries.map(entry => {
		let pointers = entry.references?.filter(item => !RESTORED_BY_OLDER_SERVERS.has(item.kind));
		if (!pointers?.length) return entry;
		let { references, ...rest } = entry;
		let kept = references!.filter(item => RESTORED_BY_OLDER_SERVERS.has(item.kind));
		return { ...rest, ...(kept.length ? { references: kept } : {}), pointers } as Wire.Entry;
	});
}

/** Puts a stored entry's pointers back among its references, in the order of the text. */
export function mergePointers(entry: Record<string, JsonValue>): void {
	if (!Object.hasOwn(entry, "pointers")) return;
	let { pointers } = entry;
	delete entry.pointers;
	if (!Array.isArray(pointers)) {
		throw new Error("hosted channel has an invalid transcript reference");
	}
	let kept = Array.isArray(entry.references) ? entry.references : [];
	let at = (item: JsonValue) =>
		typeof item === "object" && item && !Array.isArray(item) && typeof item.start === "number"
			? item.start
			: 0;
	entry.references = [...kept, ...pointers].sort((first, second) => at(first) - at(second));
}
