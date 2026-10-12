import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";

/** Each top-level block in its canonical form, or blank-line paragraphs when it cannot parse. */
function blocks(source: string): string[] {
	try {
		return parse(source).children.map(node => serialize({ type: "root", children: [node] }).trim());
	} catch {
		return source.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
	}
}

/**
 * How many top-level blocks an edit added, removed or changed. A changed block is one removal and
 * one addition, so the larger side counts. Blocks compare as a multiset, so a reorder of any size
 * adds and removes nothing; the floor of one change is what counts it, as for any other difference
 * that serializes the same.
 */
export function changedBlocks(before: string, after: string): number {
	if (before === after) return 0;
	let left = new Map<string, number>();
	for (let block of blocks(before)) left.set(block, (left.get(block) ?? 0) + 1);
	let added = 0;
	for (let block of blocks(after)) {
		let count = left.get(block) ?? 0;
		if (count > 0) left.set(block, count - 1);
		else added += 1;
	}
	let removed = [...left.values()].reduce((sum, count) => sum + count, 0);
	return Math.max(added, removed, 1);
}
