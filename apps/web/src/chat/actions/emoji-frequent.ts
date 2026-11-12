/**
 * The picker's Frequently used row and its skin tone, kept for each person in their own browser,
 * as Slack keeps them for each person: the emoji they react with most, the latest first among
 * equals, and Slack's own first picks until they have reacted enough to fill it.
 */

export type Uses = Record<string, { count: number; last: number }>;

/** Slack's defaults: thumbs up, check, eyes, raised hands, party, joy, folded hands, heart, fire. */
export const DEFAULT_FREQUENT: readonly string[] = [
	"\u{1F44D}",
	"\u2705",
	"\u{1F440}",
	"\u{1F64C}",
	"\u{1F389}",
	"\u{1F602}",
	"\u{1F64F}",
	"\u2764\uFE0F",
	"\u{1F525}",
];

/** Two rows of the picker's nine columns, as Slack shows. */
export const FREQUENT_SHOWN = 18;
const KEPT = 50;
const USES_KEY = "chopin:emoji-uses";
const TONE_KEY = "chopin:emoji-tone";

export function recordUse(uses: Uses, emoji: string, now: number): Uses {
	let next = { ...uses, [emoji]: { count: (uses[emoji]?.count ?? 0) + 1, last: now } };
	let ranked = ranking(next);
	return ranked.length > KEPT
		? Object.fromEntries(ranked.slice(0, KEPT).map(item => [item, next[item]!]))
		: next;
}

function ranking(uses: Uses): string[] {
	return Object.keys(uses).sort((a, b) =>
		uses[b]!.count - uses[a]!.count || uses[b]!.last - uses[a]!.last
	);
}

export function frequent(uses: Uses, limit = FREQUENT_SHOWN): string[] {
	let shown = ranking(uses).slice(0, limit);
	for (let emoji of DEFAULT_FREQUENT) {
		if (shown.length >= limit) break;
		if (!shown.includes(emoji)) shown.push(emoji);
	}
	return shown;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function store(): Store | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

export function readUses(storage = store()): Uses {
	try {
		let value = JSON.parse(storage?.getItem(USES_KEY) ?? "{}") as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(([, use]) =>
				Number.isFinite(use?.count) && Number.isFinite(use?.last)
			),
		) as Uses;
	} catch {
		return {};
	}
}

/** Called for every reaction this person adds, from the picker, the toolbar or a pill. */
export function noteEmojiUse(emoji: string, storage = store(), now = Date.now()): void {
	try {
		storage?.setItem(USES_KEY, JSON.stringify(recordUse(readUses(storage), emoji, now)));
	} catch {
		// A browser that keeps nothing still reacts; the row shows Slack's defaults.
	}
}

export function readTone(storage = store()): number {
	let tone = Number(storage?.getItem(TONE_KEY) ?? 0);
	return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
}

export function writeTone(tone: number, storage = store()): void {
	try {
		storage?.setItem(TONE_KEY, String(tone));
	} catch {
		// Kept for this picker only.
	}
}
