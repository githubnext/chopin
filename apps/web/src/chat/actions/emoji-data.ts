type CompactEmoji = {
	hexcode?: string;
	unicode: string;
	label: string;
	tags?: string[];
	group?: number;
	skins?: CompactEmoji[];
};

/** Slack's names for an emoji (iamcal's set, which Slack uses), by Unicode hexcode. */
type Shortcodes = Record<string, string | string[]>;

export type EmojiEntry = {
	emoji: string;
	name: string;
	/** Slack's name for it, without the colons: `+1`, `white_check_mark`. */
	shortcode: string;
	words: string;
	tones?: string[];
	variants?: { emoji: string; name: string; words: string }[];
};

export type CategoryId =
	| "people"
	| "nature"
	| "food"
	| "activity"
	| "travel"
	| "objects"
	| "symbols"
	| "flags";
export type EmojiGroup = { id: CategoryId; label: string; entries: EmojiEntry[] };

/**
 * Slack's categories, in Slack's order, from Unicode's groups: smileys and people together, and
 * Unicode's components (skin tone and hair swatches) and loose regional letters left out, as Slack
 * leaves them out.
 */
export const CATEGORIES: readonly { id: CategoryId; label: string; groups: readonly number[] }[] = [
	{ id: "people", label: "Smileys and people", groups: [0, 1] },
	{ id: "nature", label: "Animals and nature", groups: [3] },
	{ id: "food", label: "Food and drink", groups: [4] },
	{ id: "activity", label: "Activities", groups: [6] },
	{ id: "travel", label: "Travel and places", groups: [5] },
	{ id: "objects", label: "Objects", groups: [7] },
	{ id: "symbols", label: "Symbols", groups: [8] },
	{ id: "flags", label: "Flags", groups: [9] },
];

let REDUNDANT_SELECTOR = /^(\p{Emoji_Presentation})\uFE0F$/u;

export function fullyQualified(emoji: string): string {
	return emoji.replace(REDUNDANT_SELECTOR, "$1");
}

function words(label: string, tags: string[] = [], codes: string[] = []): string {
	return `${label} ${tags.join(" ")} ${codes.join(" ")}`.toLowerCase();
}

function codesOf(item: CompactEmoji, shortcodes: Shortcodes): string[] {
	let found = item.hexcode ? shortcodes[item.hexcode] : undefined;
	return found === undefined ? [] : typeof found === "string" ? [found] : found;
}

export function buildGroups(
	data: readonly CompactEmoji[],
	shortcodes: Shortcodes = {},
): EmojiGroup[] {
	let groups: EmojiGroup[] = CATEGORIES.map(({ id, label }) => ({ id, label, entries: [] }));
	let byGroup = new Map(
		CATEGORIES.flatMap((category, index) => category.groups.map(group => [group, index] as const)),
	);
	for (let item of data) {
		let index = item.group === undefined ? undefined : byGroup.get(item.group);
		if (index === undefined) continue;
		let skins = item.skins ?? [];
		let codes = codesOf(item, shortcodes);
		groups[index]!.entries.push({
			emoji: fullyQualified(item.unicode),
			name: item.label,
			shortcode: codes[0] ?? item.label.toLowerCase().replace(/[^\p{L}\p{N}+-]+/gu, "_"),
			words: words(item.label, item.tags, codes),
			...(skins.length === 5 ? { tones: skins.map(skin => fullyQualified(skin.unicode)) } : {}),
			...(skins.length > 0
				? {
					variants: skins.map(skin => ({
						emoji: fullyQualified(skin.unicode),
						name: skin.label,
						words: words(skin.label, item.tags, codes),
					})),
				}
				: {}),
		});
	}
	return groups.filter(group => group.entries.length > 0);
}

let loaded: Promise<EmojiGroup[]> | undefined;

/** The catalog and Slack's names, fetched the first time a picker opens and kept after. */
export function loadEmoji(): Promise<EmojiGroup[]> {
	loaded ??= Promise.all([
		import("emojibase-data/en/compact.json") as Promise<{ default: CompactEmoji[] }>,
		import("emojibase-data/en/shortcodes/iamcal.json") as Promise<{ default: Shortcodes }>,
	]).then(([catalog, names]) => buildGroups(catalog.default, names.default));
	return loaded;
}

export type EmojiChoice = { emoji: string; name: string; shortcode?: string };

/** Slack's numbering of the five skin tones after the default: `skin-tone-2` to `skin-tone-6`. */
export function shortcodeAt(shortcode: string, tone: number): string {
	return tone > 0 ? `:${shortcode}::skin-tone-${tone + 1}:` : `:${shortcode}:`;
}

export function shownAt(entry: EmojiEntry, tone: number): EmojiChoice {
	let emoji = tone > 0 ? entry.tones?.[tone - 1] : undefined;
	return {
		emoji: emoji ?? entry.emoji,
		name: entry.name,
		shortcode: shortcodeAt(entry.shortcode, emoji ? tone : 0),
	};
}

/** Every emoji the catalog can draw, any tone included, with what the preview says of it. */
export function emojiIndex(groups: EmojiGroup[]): Map<string, EmojiChoice> {
	let index = new Map<string, EmojiChoice>();
	for (let entry of groups.flatMap(group => group.entries)) {
		index.set(entry.emoji, shownAt(entry, 0));
		entry.tones?.forEach((_, tone) => {
			let shown = shownAt(entry, tone + 1);
			index.set(shown.emoji, shown);
		});
		for (let variant of entry.variants ?? []) {
			if (!index.has(variant.emoji)) {
				index.set(variant.emoji, { emoji: variant.emoji, name: variant.name });
			}
		}
	}
	return index;
}

export function searchEmoji(query: string, groups: EmojiGroup[], tone = 0): EmojiChoice[] {
	let wanted = query.toLowerCase().replace(/:/g, " ").split(/\s+/).filter(Boolean);
	if (wanted.length === 0) {
		return groups.flatMap(group => group.entries.map(entry => shownAt(entry, tone)));
	}
	let matches = (text: string) => wanted.every(word => text.includes(word));
	return groups.flatMap(group =>
		group.entries.flatMap(entry => [
			...(matches(entry.words) ? [shownAt(entry, tone)] : []),
			...(entry.variants ?? []).filter(variant => matches(variant.words) && !matches(entry.words))
				.map(variant => ({ emoji: variant.emoji, name: variant.name })),
		])
	);
}
