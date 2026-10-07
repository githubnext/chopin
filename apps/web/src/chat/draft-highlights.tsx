import type { ReferenceDraft } from "../chat/references";

export function writeDraft(
	element: HTMLElement,
	text: string,
	references: ReferenceDraft[],
	mentions: readonly string[] = [],
) {
	let fragment = document.createDocumentFragment();
	let end = 0;
	let known = new Set(mentions.map(login => login.toLowerCase()));
	let appendText = (source: string) => {
		let end = 0;
		for (let match of source.matchAll(/(^|[^\w@])(@[\w-]+)/g)) {
			let token = match[2]!;
			if (!known.has(token.slice(1).toLowerCase())) continue;
			let start = match.index + match[1]!.length;
			fragment.append(document.createTextNode(source.slice(end, start)));
			let span = document.createElement("span");
			span.className = "draft-mention";
			span.dataset.mention = token.slice(1);
			span.textContent = token;
			fragment.append(span);
			end = start + token.length;
		}
		fragment.append(document.createTextNode(source.slice(end)));
	};
	for (let reference of [...references].sort((left, right) => left.start - right.start)) {
		appendText(text.slice(end, reference.start));
		let span = document.createElement("span");
		span.className = "draft-reference";
		span.dataset.documentId = reference.channelId;
		span.textContent = text.slice(reference.start, reference.end);
		fragment.append(span);
		end = reference.end;
	}
	appendText(text.slice(end));
	if (!text || text.endsWith("\n")) fragment.append(document.createElement("br"));
	element.replaceChildren(fragment);
}
