import { parse } from "./parse";
import { serialize } from "./serialize";
import type { Heading, Root } from "mdast";

export const MAX_TITLE_LENGTH = 50;

/** Reject damaged text rather than normalizing a corrupt title into a plausible one. */
export function validDocumentTitleText(value: string): boolean {
	return !/[\p{Cc}\p{Cs}\uFFFD]/u.test(value.replace(/[\t\r\n]/gu, ""));
}

/** Editable text retains edge spaces so typing a word separator survives collaboration. */
export function boundDocumentTitle(value: string): string {
	return [...value.replace(/[\r\n]/gu, " ")].slice(0, MAX_TITLE_LENGTH).join("");
}

/** Canonical display/input title, bounded by Unicode code points. */
export function normalizeDocumentTitle(value: string): string {
	return [...value.replace(/\s+/gu, " ").trim()].slice(0, MAX_TITLE_LENGTH).join("");
}

export function displayTitle(value: string): string {
	return normalizeDocumentTitle(value) || "Untitled";
}

function plainText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	let node = value as { value?: string; alt?: string; children?: unknown[] };
	return node.children?.map(plainText).join("") ?? node.value ?? node.alt ?? "";
}

/** Only the leading H1 is a title; body headings remain ordinary blocks. */
export function documentTitleText(root: Root): string | undefined {
	let first = root.children[0];
	return first?.type === "heading" && first.depth === 1
		? normalizeDocumentTitle(plainText(first))
		: undefined;
}

/** Previously accepted damaged titles remain recoverable, but new writes cannot introduce one. */
export function validDocumentTitleChange(before: Root, after: Root): boolean {
	let text = (root: Root) => {
		let first = root.children[0];
		return first?.type === "heading" && first.depth === 1 ? plainText(first) : undefined;
	};
	let proposed = text(after);
	return proposed === undefined || validDocumentTitleText(proposed) || proposed === text(before);
}

/** Keep every body block's identity when initializing or replacing the title. */
export function normalizeDocumentTitleTree(root: Root, fallback = "", replacement?: string): Root {
	let existing = documentTitleText(root);
	let title = normalizeDocumentTitle(replacement ?? existing ?? fallback);
	let first = root.children[0];
	if (
		existing !== undefined && first?.type === "heading"
		&& first.children.length === (title ? 1 : 0)
		&& (!title || first.children[0]?.type === "text" && first.children[0].value === title)
	) {
		return root;
	}
	let heading: Heading = {
		type: "heading",
		depth: 1,
		children: title ? [{ type: "text", value: title }] : [],
	};
	return { ...root, children: [heading, ...root.children.slice(existing === undefined ? 0 : 1)] };
}

export function withDocumentTitle(source: string, title: string): string {
	if (!validDocumentTitleText(title)) {
		throw new Error("Document title contains control characters or damaged Unicode text");
	}
	return serialize(normalizeDocumentTitleTree(parse(source), "", title));
}

/** A title alone is empty document prose. */
export function documentBodySource(source: string): string {
	let root = parse(source);
	return serialize({
		...root,
		children: root.children.slice(documentTitleText(root) === undefined ? 0 : 1),
	});
}
