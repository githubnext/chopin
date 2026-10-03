import type { ConversationPlan } from "@chopin/protocol";

export type ChatDestination = {
	source: ConversationPlan.SourceRef;
	itemId: string;
	token: number;
};

const sourceRanges = new Map<object, Range>();

function publishSourceHighlights(): void {
	if (!CSS.highlights) return;
	if (sourceRanges.size === 0) CSS.highlights.delete("conversation-source");
	else CSS.highlights.set("conversation-source", new Highlight(...sourceRanges.values()));
}

/** Highlight only when raw UTF-16 offsets map to the rendered message exactly. */
export function highlightSource(
	owner: object,
	element: HTMLElement,
	source: ConversationPlan.SourceRef,
): boolean {
	clearSourceHighlight(owner);
	let container = element.querySelector<HTMLElement>("[data-chat-message-text]");
	let raw = element.getAttribute("data-chat-raw");
	if (!container || raw === null || container.textContent !== raw) return false;
	if (raw.slice(source.start, source.end) !== source.quote) return false;
	let walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	let startNode: Text | undefined;
	let endNode: Text | undefined;
	let startOffset = 0;
	let endOffset = 0;
	let offset = 0;
	while (walker.nextNode()) {
		let node = walker.currentNode as Text;
		let next = offset + node.length;
		if (!startNode && source.start >= offset && source.start <= next) {
			startNode = node;
			startOffset = source.start - offset;
		}
		if (!endNode && source.end >= offset && source.end <= next) {
			endNode = node;
			endOffset = source.end - offset;
		}
		offset = next;
	}
	if (!startNode || !endNode || !CSS.highlights) return false;
	let range = new Range();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	sourceRanges.set(owner, range);
	publishSourceHighlights();
	return true;
}

export function clearSourceHighlight(owner: object): void {
	if (sourceRanges.delete(owner)) publishSourceHighlights();
}
