export const MAX_TITLE_LENGTH = 120;

/** Canonical browser and MCP rename title, after removing accidental edge whitespace. */
export function normalizedTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let title = value.trim();
	let length = Array.from(title).length;
	return length >= 1 && length <= MAX_TITLE_LENGTH ? title : undefined;
}

/** Pick the first case-insensitive title not already used in one repository. */
export function availableChannelTitle(requested: string, existing: Iterable<string>): string {
	let titles = new Set([...existing].map(title => title.toLowerCase()));
	if (!titles.has(requested.toLowerCase())) return requested;
	for (let index = 2; index <= titles.size + 2; index++) {
		let suffix = ` (${index})`;
		let candidate = `${
			[...requested].slice(0, MAX_TITLE_LENGTH - [...suffix].length).join("").trimEnd()
		}${suffix}`;
		if (!titles.has(candidate.toLowerCase())) return candidate;
	}
	throw new Error("could not reserve an available channel title");
}
