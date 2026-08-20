export const MAX_TITLE_LENGTH = 120;

/** Canonical browser and MCP rename title, after removing accidental edge whitespace. */
export function normalizedTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let title = value.trim();
	let length = Array.from(title).length;
	return length >= 1 && length <= MAX_TITLE_LENGTH ? title : undefined;
}
