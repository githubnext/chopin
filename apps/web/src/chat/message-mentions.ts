/**
 * Every `@login` in a sent message that names someone the document knows (a person here, one who
 * can read it, one who has spoken in Chat, or chopin) is drawn as a mention, as the draft draws it
 * while it is typed. The same boundary as the draft's: an `@` that starts the text or follows
 * neither a word character nor another `@`, so `a@b.com` is an address. A login no one here has
 * stays the words it is. Code and links keep their characters.
 */

import { createContext } from "react";

/** The logins, in lower case, that a message's `@login` may name. */
export const MentionLogins = createContext<ReadonlySet<string>>(new Set());

type MarkdownNode = {
	type: string;
	value?: string;
	children?: MarkdownNode[];
	data?: unknown;
};

const SKIPPED = new Set(["code", "inlineCode", "link", "linkReference", "html"]);
const MENTION = /(^|[^\w@])@([\w-]+)/g;

function mention(token: string): MarkdownNode {
	return {
		type: "chatMention",
		children: [{ type: "text", value: token }],
		data: {
			hName: "span",
			hProperties: { className: ["chat-mention"], "data-mention": token.slice(1) },
		},
	};
}

/** Splits one text into its words and its mentions; undefined where it names no one. */
export function mentionRuns(
	text: string,
	known: ReadonlySet<string>,
	afterWord = false,
): MarkdownNode[] | undefined {
	let runs: MarkdownNode[] = [];
	let at = 0;
	for (let match of text.matchAll(MENTION)) {
		let start = match.index + match[1]!.length;
		if (start === 0 && afterWord) continue;
		if (!known.has(match[2]!.toLowerCase())) continue;
		if (start > at) runs.push({ type: "text", value: text.slice(at, start) });
		let end = start + 1 + match[2]!.length;
		runs.push(mention(text.slice(start, end)));
		at = end;
	}
	if (at === 0) return undefined;
	if (at < text.length) runs.push({ type: "text", value: text.slice(at) });
	return runs;
}

/** A remark plugin: `[mentionRemarkPlugin, logins]`. */
export function mentionRemarkPlugin(known: ReadonlySet<string>) {
	let visit = (node: MarkdownNode) => {
		if (!node.children || SKIPPED.has(node.type)) return;
		let previous: MarkdownNode | undefined;
		node.children = node.children.flatMap(child => {
			let before = previous;
			previous = child;
			if (child.type !== "text" || !child.value) {
				visit(child);
				return [child];
			}
			let afterWord = before?.type === "text" && /[\w@]$/.test(before.value ?? "");
			return mentionRuns(child.value, known, afterWord) ?? [child];
		});
	};
	return (tree: MarkdownNode) => {
		if (known.size) visit(tree);
	};
}
