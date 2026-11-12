/**
 * The anchor a document's heading is told by: what a `#section` link names, a heading mention
 * carries, and the browser scrolls to. One rule on both sides, so a link the Planner writes from a
 * mention's anchor lands where a reader's click goes.
 */

/**
 * A heading's text as an anchor, as GitHub makes one: lowercase, with whatever is not a letter, a
 * digit, a space, a hyphen or an underscore removed and each space a hyphen. Nothing left is
 * `section`.
 */
export function headingAnchor(text: string): string {
	let slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
	return slug || "section";
}

/**
 * The anchors of a document's top-level headings, given their text in document order: a repeat
 * takes `-1`, `-2` and so on after the first, as GitHub's do.
 */
export function headingAnchors(texts: readonly string[]): string[] {
	let seen = new Map<string, number>();
	return texts.map(text => {
		let base = headingAnchor(text.replace(/\s+/g, " ").trim());
		let repeats = seen.get(base) ?? 0;
		seen.set(base, repeats + 1);
		return repeats === 0 ? base : `${base}-${repeats}`;
	});
}
