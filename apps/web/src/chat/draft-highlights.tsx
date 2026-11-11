import type { ReferenceDraft } from "../chat/references";

export function writeDraft(
	element: HTMLElement,
	text: string,
	references: ReferenceDraft[],
	mentions: readonly string[] = [],
	/** What is being said and not yet settled: drawn beside `at`, and never part of `text`. */
	interim?: { at: number; text: string },
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
	// The interim words are a mark in the text that draws them from `data-interim`, so they are not
	// in the draft's text: its offsets, selection and history are what they would be without them.
	// A reference is never split by it: they are drawn after one that holds their place.
	let ghostAt = interim
		? references.find(reference => reference.start < interim.at && reference.end > interim.at)?.end
			?? interim.at
		: undefined;
	let placed = ghostAt === undefined;
	let segment = (from: number, to: number) => {
		if (!placed && ghostAt! >= from && ghostAt! <= to) {
			appendText(text.slice(from, ghostAt));
			let span = document.createElement("span");
			span.className = "draft-interim";
			span.dataset.interim = interim!.text;
			span.contentEditable = "false";
			fragment.append(span);
			placed = true;
			appendText(text.slice(ghostAt, to));
		} else appendText(text.slice(from, to));
	};
	for (let reference of [...references].sort((left, right) => left.start - right.start)) {
		segment(end, reference.start);
		let span = document.createElement("span");
		span.className = "draft-reference";
		span.dataset.reference = reference.kind;
		if (reference.kind === "document") span.dataset.documentId = reference.channelId;
		span.textContent = text.slice(reference.start, reference.end);
		fragment.append(span);
		end = reference.end;
		if (!placed && ghostAt === end) segment(end, end);
	}
	segment(end, text.length);
	if (!text || text.endsWith("\n")) fragment.append(document.createElement("br"));
	element.replaceChildren(fragment);
}
