/**
 * Selecting text in a rendered preview with the pointer.
 *
 * A preview sits inside the editable root, and Chromium answers a press there
 * by putting the caret at the nearest editable position: the block's source,
 * hidden while the preview shows. A drag then selects nothing visible, and
 * copying code out of a preview is impossible. Coloured code is also drawn in
 * shadow roots, which a selection begun in the light tree never enters.
 *
 * So the press is taken over: the browser's default is cancelled, and the
 * selection is set from the points under the pointer, inside the shadow roots
 * the renderer draws in. Double and triple presses select a word and a line,
 * as they would anywhere else; for a writer the first click of those has
 * already opened the source, so in practice they serve readers. The selection
 * never touches the editor's text, so Lexical leaves it alone.
 */

type CaretPositionAt = (
	x: number,
	y: number,
	options?: { shadowRoots?: ShadowRoot[] },
) => { offsetNode: Node; offset: number } | null;

type Point = { node: Node; offset: number };

function shadowRoots(preview: HTMLElement): ShadowRoot[] {
	return [preview, ...preview.querySelectorAll("*")].flatMap(element =>
		element.shadowRoot ? [element.shadowRoot] : []
	);
}

function inside(preview: HTMLElement, node: Node): boolean {
	for (let at: Node | null = node; at; at = (at.getRootNode() as ShadowRoot).host ?? null) {
		if (preview.contains(at)) return true;
		if (!(at.getRootNode() instanceof ShadowRoot)) return false;
	}
	return false;
}

function pointAt(preview: HTMLElement, x: number, y: number): Point | undefined {
	let at = (preview.ownerDocument as unknown as { caretPositionFromPoint?: CaretPositionAt })
		.caretPositionFromPoint?.(x, y, { shadowRoots: shadowRoots(preview) });
	if (!at || !inside(preview, at.offsetNode)) return undefined;
	return { node: at.offsetNode, offset: at.offset };
}

/** The drawn line, or failing that the text node, holding a point. */
function lineOf(point: Point): Node {
	let element = point.node instanceof Element ? point.node : point.node.parentElement;
	return element?.closest("[data-line]") ?? point.node;
}

/**
 * Listens on an editor root for presses that start on a preview.
 * `preview` names the preview an event target is in, if any.
 */
export function registerPreviewSelection(
	root: HTMLElement,
	preview: (target: Element) => HTMLElement | null,
): () => void {
	let document = root.ownerDocument;
	let drag: { preview: HTMLElement; anchor: Point } | undefined;

	let down = (event: MouseEvent) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
		let target = event.target instanceof Element ? preview(event.target) : null;
		if (!target) return;
		let point = pointAt(target, event.clientX, event.clientY);
		if (!point) return;
		event.preventDefault();
		target.focus({ preventScroll: true });
		let selection = document.getSelection();
		if (!selection) return;

		if (event.detail >= 3) {
			let range = document.createRange();
			range.selectNodeContents(lineOf(point));
			selection.removeAllRanges();
			selection.addRange(range);
			return;
		}
		// Shift extends a selection already in this preview, as it would in text.
		let anchor = event.shiftKey && selection.anchorNode && inside(target, selection.anchorNode)
			? { node: selection.anchorNode, offset: selection.anchorOffset }
			: undefined;
		if (anchor) {
			selection.setBaseAndExtent(anchor.node, anchor.offset, point.node, point.offset);
			drag = { preview: target, anchor };
			return;
		}
		selection.collapse(point.node, point.offset);
		if (event.detail === 2) {
			selection.modify("move", "backward", "word");
			selection.modify("extend", "forward", "word");
			return;
		}
		drag = { preview: target, anchor: point };
	};

	let move = (event: MouseEvent) => {
		if (!drag) return;
		let point = pointAt(drag.preview, event.clientX, event.clientY);
		if (!point) return;
		document.getSelection()?.setBaseAndExtent(
			drag.anchor.node,
			drag.anchor.offset,
			point.node,
			point.offset,
		);
	};

	let up = () => {
		drag = undefined;
	};

	root.addEventListener("mousedown", down);
	document.addEventListener("mousemove", move);
	document.addEventListener("mouseup", up);
	return () => {
		root.removeEventListener("mousedown", down);
		document.removeEventListener("mousemove", move);
		document.removeEventListener("mouseup", up);
	};
}
