import "./pane-drag-skip.css";

/**
 * Dragging a pane's edge changes the width of the document and of Chat on every frame, and the page
 * lays both out again each time: on a long document with sixteen tables and a Chat of a hundred
 * messages that is most of a frame's cost, and only what is on screen needs it.
 *
 * While an edge is dragged the page leaves its big blocks that are far from the screen out of layout
 * (`content-visibility: auto`, which the browser lifts for whatever comes near the reader, holds the
 * selection or has focus). A block left out keeps the height it had when the drag began, written here
 * as a custom property before anything changes, so nothing above or below the reader moves when the
 * drag starts. The stylesheet does the skipping, only for blocks marked here and only while the page
 * carries `data-pane-dragging`; both come away when the drag ends, and the page is laid out once, as
 * it would be after any other resize.
 *
 * Only blocks that are far away are marked, and those the reader sees or is about to see are left as
 * they are. With every block marked, the browser stopped keeping the reader's place while blocks above
 * changed height: Chat, scrolled up through its history, ended a drag several rows from where it had
 * been, and a document scrolled near its end moved by a screen. Unmarked blocks near the screen keep
 * that anchoring, and cost nothing extra, since the browser lays out what is near the screen even
 * when a block is marked.
 */

export const PANE_DRAGGING = "data-pane-dragging";
export const DRAG_SKIP = "data-drag-skip";
export const DRAG_SKIP_SIZE = "--drag-skip-size";

/**
 * The blocks worth leaving out: a document's tables and its code and diagram blocks, which are most
 * of its layout, and each row of Chat. A block is marked only when it is far from the window, so
 * the containment `content-visibility: auto` implies cannot clip anything the reader sees; one
 * that comes into view during the drag is drawn by the browser as it arrives. The document's prose
 * is cheap and is left as it is.
 */
export const SKIPPABLE_BLOCKS = ".plan-content > :is(table, .planCode), [data-chat-stack] > *";

/** How far from the window a block may be and still be left alone, as a share of the window's height. */
export const NEAR = 0.5;

export type BlockBox = {
	/** The block's border widths, top and bottom. */
	border: number;
	/** The block's border box. */
	height: number;
	/** The block's padding, top and bottom. */
	padding: number;
	/** Where the block's border box begins, from the top of the window. */
	top: number;
};

/** `contain-intrinsic-block-size` is the size of the content box, whatever `box-sizing` says. */
export function skippedSize({ border, height, padding }: BlockBox): number {
	return Math.max(0, height - padding - border);
}

/** Whether a block is on the window or within `NEAR` of the window's height of it, above or below. */
export function isNear(
	{ height, top }: Pick<BlockBox, "height" | "top">,
	viewport: number,
): boolean {
	let margin = viewport * NEAR;
	return top + height > -margin && top < viewport + margin;
}

export type SkippableBlock = {
	/** The block as it is laid out now, or nothing for one that takes no room in the flow. */
	measure: () => BlockBox | undefined;
	skip: (size: number) => void;
	unskip: () => void;
};

export type DragHost = {
	blocks: () => SkippableBlock[];
	/** The height of the window, which the blocks' places are measured in. */
	height: () => number;
	/** The page-wide signal that a drag is in progress. */
	mark: (on: boolean) => void;
};

/**
 * One hold for as many drags as are in progress: the first measures and marks, the last lets go.
 * Every block is measured before any is marked, so that marking one cannot change what the next
 * reads.
 */
export function createPaneDragHold(host: DragHost): () => () => void {
	let holds = 0;
	let held: SkippableBlock[] = [];
	return () => {
		if (holds++ === 0) {
			let sized: { block: SkippableBlock; size: number }[] = [];
			let viewport = host.height();
			for (let block of host.blocks()) {
				let box = block.measure();
				if (box && !isNear(box, viewport)) sized.push({ block, size: skippedSize(box) });
			}
			for (let { block, size } of sized) block.skip(size);
			held = sized.map(({ block }) => block);
			host.mark(true);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--holds > 0) return;
			host.mark(false);
			for (let block of held) block.unskip();
			held = [];
		};
	};
}

function pixels(value: string): number {
	return Number.parseFloat(value) || 0;
}

function pageBlock(element: HTMLElement): SkippableBlock {
	return {
		measure() {
			let style = getComputedStyle(element);
			// Out of the flow, or without a box: nothing is skipped by a size it does not have.
			if (
				style.display === "none" || style.display === "contents" || style.position === "absolute"
				|| style.position === "fixed"
			) return;
			let { height, top } = element.getBoundingClientRect();
			if (height === 0) return;
			return {
				border: pixels(style.borderTopWidth) + pixels(style.borderBottomWidth),
				height,
				padding: pixels(style.paddingTop) + pixels(style.paddingBottom),
				top,
			};
		},
		skip(size) {
			element.setAttribute(DRAG_SKIP, "");
			element.style.setProperty(DRAG_SKIP_SIZE, `${size}px`);
		},
		unskip() {
			element.removeAttribute(DRAG_SKIP);
			element.style.removeProperty(DRAG_SKIP_SIZE);
			// The property was the only thing in it: leave the element as it was found.
			if (element.getAttribute("style") === "") element.removeAttribute("style");
		},
	};
}

/**
 * Holds the page's big blocks out of layout until the returned function is called. Called when an
 * edge starts to move, and the function when the drag is over, however it ended.
 */
export let holdPaneDrag = createPaneDragHold({
	blocks: () => Array.from(document.querySelectorAll<HTMLElement>(SKIPPABLE_BLOCKS), pageBlock),
	height: () => innerHeight,
	mark: on => document.documentElement.toggleAttribute(PANE_DRAGGING, on),
});
