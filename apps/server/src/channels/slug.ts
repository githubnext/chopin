export const MAX_DOCUMENT_SLUG_LENGTH = 100;

function truncatedSlug(value: string, maximum: number): string {
	return Array.from(value).slice(0, maximum).join("").replace(/-+$/u, "");
}

export function documentSlug(title: string): string {
	let slug = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	if (!slug) return "document";
	return truncatedSlug(slug, MAX_DOCUMENT_SLUG_LENGTH);
}

/** Adds a collision suffix to a bounded base returned by documentSlug. */
export function documentSlugCandidate(base: string, index: number): string {
	if (!Number.isSafeInteger(index) || index < 1) {
		throw new RangeError("document slug candidate index must be a positive safe integer");
	}
	if (index === 1) return base;
	let suffix = `-${index}`;
	let stem = truncatedSlug(base, MAX_DOCUMENT_SLUG_LENGTH - Array.from(suffix).length);
	return `${stem}${suffix}`;
}
