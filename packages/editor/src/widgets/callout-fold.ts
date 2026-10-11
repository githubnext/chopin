/**
 * Whether a callout shows only its leading blocks.
 *
 * Folding is a view preference: the document's `fold` says how many blocks lead,
 * and each reader opens the rest for themselves. A caret inside a hidden block
 * always opens it, so nobody types into something they cannot see.
 */
export type Fold = "none" | "folded" | "open";

export function foldOf(
	{ fold, blocks, opened, caret }: {
		/** Leading blocks the document keeps visible; 0 never folds. */
		fold: number;
		/** Blocks in the callout's body. */
		blocks: number;
		/** The reader opened it. */
		opened: boolean;
		/** Index of the body block holding the caret, if it is in this callout. */
		caret?: number;
	},
): Fold {
	if (fold <= 0 || blocks <= fold) return "none";
	if (opened || (caret !== undefined && caret >= fold)) return "open";
	return "folded";
}
