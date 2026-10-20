import { MAX_TITLE_LENGTH, normalizeDocumentTitle, validDocumentTitleText } from "@chopin/dialect";
export { MAX_TITLE_LENGTH };

/** Explicit titles share the same normalization as authored headings. */
export function normalizedTitle(value: unknown): string | undefined {
	return typeof value === "string" && validDocumentTitleText(value)
		? normalizeDocumentTitle(value)
		: undefined;
}
