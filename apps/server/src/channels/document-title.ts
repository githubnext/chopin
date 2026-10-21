type Random = () => number;

/** Intentionally hand-picked words: readable names beat an opaque random identifier. */
export const adjectives = [
	"amber",
	"ancient",
	"ardent",
	"autumn",
	"bold",
	"brisk",
	"bright",
	"calm",
	"celestial",
	"clear",
	"cobalt",
	"crimson",
	"curious",
	"daring",
	"dawn",
	"distant",
	"eager",
	"electric",
	"fading",
	"feral",
	"flowing",
	"flowering",
	"gentle",
	"golden",
	"grand",
	"hidden",
	"hollow",
	"hushed",
	"iron",
	"ivory",
	"jolly",
	"keen",
	"lively",
	"lunar",
	"mellow",
	"misty",
	"modern",
	"mossy",
	"nimble",
	"northern",
	"open",
	"orange",
	"patient",
	"pearl",
	"quiet",
	"radiant",
	"rapid",
	"red",
	"rising",
	"royal",
	"rustic",
	"sable",
	"sacred",
	"silver",
	"soft",
	"solar",
	"steady",
	"summer",
	"swift",
	"tidal",
	"verdant",
	"violet",
	"warm",
	"wild",
	"willow",
	"winter",
	"wise",
	"young",
];

export const nouns = [
	"anchor",
	"arch",
	"arrow",
	"basin",
	"beacon",
	"birch",
	"bird",
	"bridge",
	"brook",
	"canyon",
	"castle",
	"chicken",
	"circle",
	"cloud",
	"comet",
	"copper",
	"creek",
	"crown",
	"dawn",
	"delta",
	"drift",
	"falcon",
	"field",
	"fire",
	"forest",
	"garden",
	"gate",
	"glade",
	"harbor",
	"hawk",
	"hill",
	"island",
	"lake",
	"lantern",
	"leaf",
	"marsh",
	"meadow",
	"moon",
	"mountain",
	"ocean",
	"orchard",
	"otter",
	"path",
	"peak",
	"pine",
	"planet",
	"rain",
	"river",
	"road",
	"rook",
	"sail",
	"shadow",
	"shore",
	"sky",
	"spring",
	"star",
	"stone",
	"storm",
	"stream",
	"summit",
	"thunder",
	"trail",
	"valley",
	"water",
	"wave",
	"willow",
	"wind",
	"wing",
	"wood",
];

function pick(words: readonly string[], random: Random): string {
	let index = Math.min(words.length - 1, Math.max(0, Math.floor(random() * words.length)));
	return words[index]!;
}

export function documentTitle(random: Random = Math.random): string {
	return `${pick(adjectives, random)}-${pick(nouns, random)}`;
}

/** A random starting point, followed by every possible readable title exactly once. */
export function* documentTitles(random: Random = Math.random): IterableIterator<string> {
	let count = adjectives.length * nouns.length;
	let start = Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
	for (let offset = 0; offset < count; offset++) {
		let index = (start + offset) % count;
		let adjective = adjectives[Math.floor(index / nouns.length)]!;
		let noun = nouns[index % nouns.length]!;
		yield `${adjective}-${noun}`;
	}
}

let adjectiveSet = new Set(adjectives);
let nounSet = new Set(nouns);

/** Whether a title is still a name Chopin generated because its creator gave none. */
export function generatedTitle(value: string): boolean {
	let [adjective, noun, ...rest] = value.split("-");
	return rest.length === 0 && adjectiveSet.has(adjective!) && nounSet.has(noun ?? "");
}

/**
 * A draft may replace a blank or generated title, or the one a Planner last drafted, until a
 * person renames the document: their title is then theirs, whatever it is.
 */
export function draftableTitle(
	title: string,
	plan: { plannerTitle?: string; titleChosen?: boolean },
): boolean {
	return !plan.titleChosen && (!title || title === plan.plannerTitle || generatedTitle(title));
}

/** How long after a person last had the title open a drafted title still waits. */
export const TITLE_HOLD_MS = 60_000;

/** Who has the title open, or has typed in it, on which connection. Never persisted. */
export type Titling = {
	people: Map<object, { active: boolean; edited: boolean }>;
	/** When someone last let go of the title. */
	releasedAt?: number;
};

/** A person is renaming, or about to: a drafted title must not race them. */
export function titleHeld(titling: Titling | undefined, now: number): boolean {
	if (!titling) return false;
	for (let person of titling.people.values()) if (person.active || person.edited) return true;
	return titling.releasedAt !== undefined && now - titling.releasedAt < TITLE_HOLD_MS;
}
