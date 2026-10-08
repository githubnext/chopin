/**
 * Put the caret after the last editable text in a document editor.
 *
 * The editor reads the browser selection on `selectionchange`, so a DOM range
 * is enough; decorator blocks such as cards are skipped because they cannot
 * hold a caret.
 */
export function focusDocumentEnd(root: HTMLElement): boolean {
	let block = root.lastElementChild;
	while (block && block.closest('[contenteditable="false"]') !== null) {
		block = block.previousElementSibling;
	}
	if (!block) return false;
	let walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	let text: Text | undefined;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest('[contenteditable="false"]')) text = node as Text;
	}
	let range = document.createRange();
	if (text) range.setStart(text, text.length);
	else range.setStart(block, 0);
	range.collapse(true);
	root.focus({ preventScroll: true });
	let selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	block.scrollIntoView({ block: "nearest" });
	return true;
}
