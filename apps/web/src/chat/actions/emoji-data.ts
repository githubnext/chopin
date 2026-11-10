type CompactEmoji = {
	unicode: string;
	label: string;
	tags?: string[];
	group?: number;
	skins?: CompactEmoji[];
};

export type EmojiEntry = {
	emoji: string;
	name: string;
	words: string;
	/** The five single skin tones of an emoji that has them, lightest first. */
	tones?: string[];
	variants?: { emoji: string; name: string; words: string }[];
};
export type EmojiGroup = { label: string; entries: EmojiEntry[] };

let GROUP_LABELS = [
	"Smileys and emotion",
	"People and body",
	"Components",
	"Animals and nature",
	"Food and drink",
	"Travel and places",
	"Activities",
	"Objects",
	"Symbols",
	"Flags",
];

let REDUNDANT_SELECTOR = /^(\p{Emoji_Presentation})\uFE0F$/u;

/** Unicode's fully-qualified spelling: emojibase adds a selector to every emoji, which only ❤️ and its kind need. */
export function fullyQualified(emoji: string): string {
	return emoji.replace(REDUNDANT_SELECTOR, "$1");
}

function words(label: string, tags: string[] = []): string {
	return `${label} ${tags.join(" ")}`.toLowerCase();
}

export function buildGroups(data: readonly CompactEmoji[]): EmojiGroup[] {
	let groups: EmojiGroup[] = GROUP_LABELS.map(label => ({ label, entries: [] }));
	for (let item of data) {
		let group = groups[item.group ?? GROUP_LABELS.length - 1] ?? groups.at(-1)!;
		let skins = item.skins ?? [];
		group.entries.push({
			emoji: fullyQualified(item.unicode),
			name: item.label,
			words: words(item.label, item.tags),
			...(skins.length === 5 ? { tones: skins.map(skin => fullyQualified(skin.unicode)) } : {}),
			...(skins.length > 0
				? {
					variants: skins.map(skin => ({
						emoji: fullyQualified(skin.unicode),
						name: skin.label,
						words: words(skin.label, item.tags),
					})),
				}
				: {}),
		});
	}
	return groups.filter(group => group.entries.length > 0);
}

let loaded: Promise<EmojiGroup[]> | undefined;

/** Every emoji Unicode lists, with its CLDR name and keywords, fetched the first time a picker opens. */
export function loadEmoji(): Promise<EmojiGroup[]> {
	loaded ??= (import("emojibase-data/en/compact.json") as Promise<{ default: CompactEmoji[] }>)
		.then(module => buildGroups(module.default));
	return loaded;
}

export type EmojiChoice = { emoji: string; name: string };

/** What an entry shows at a skin tone: 0 is the emoji as listed, 1 to 5 the tones from lightest. */
export function shownAt(entry: EmojiEntry, tone: number): EmojiChoice {
	let emoji = tone > 0 ? entry.tones?.[tone - 1] : undefined;
	return { emoji: emoji ?? entry.emoji, name: entry.name };
}

/**
 * The listed emoji whose name or keywords have every word of the query. Searching also reaches every
 * skin tone variant, so each one can be found even where the tone setting does not apply to it.
 */
export function searchEmoji(query: string, groups: EmojiGroup[], tone = 0): EmojiChoice[] {
	let wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
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
