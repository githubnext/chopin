import type { ReferenceDraft } from "../chat/references";

export function writeDraft(element: HTMLElement, text: string, references: ReferenceDraft[]) {
	let fragment = document.createDocumentFragment();
	let end = 0;
	for (let reference of [...references].sort((left, right) => left.start - right.start)) {
		fragment.append(document.createTextNode(text.slice(end, reference.start)));
		let span = document.createElement("span");
		span.className = "draft-reference";
		span.dataset.documentId = reference.channelId;
		span.textContent = text.slice(reference.start, reference.end);
		fragment.append(span);
		end = reference.end;
	}
	fragment.append(document.createTextNode(text.slice(end)));
	if (!text || text.endsWith("\n")) fragment.append(document.createElement("br"));
	element.replaceChildren(fragment);
}
