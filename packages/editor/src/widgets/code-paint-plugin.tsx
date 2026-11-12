/**
 * Colours every named code block in place, with CSS Custom Highlights over its own text.
 *
 * The highlighter is the one Chat and the diff view share (`code-tokens.ts`), loaded with the
 * first block that names a language. Each block is painted again only when its text, its language
 * or its element changed, and synchronously after the update that changed it, so the colours never
 * trail the caret by a frame. A browser without Custom Highlights shows the code uncoloured,
 * and still editable.
 */

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode } from "lexical";
import { $isCodeBlockNode } from "@chopin/dialect";

import { paintShared } from "../marks";
import { kindOf } from "./code";
import { pieces, ranges, spans } from "./code-paint";
import { colour, loadedTokenizer, loadTokenizer } from "./code-tokens";

import type { ElementNode, LexicalEditor } from "lexical";
import type { Coloured } from "./code-tokens";

/** The roles' highlights are named for them: `::highlight(plan-code-keyword)`. */
const PREFIX = "plan-code-";

type Painted = {
	element: HTMLElement;
	source: string;
	language: string;
	held?: Coloured;
	/** The text nodes the ranges are in: Lexical may replace one without changing the text. */
	nodes: Text[];
	byRole: Map<string, Range[]>;
};

type Block = { key: string; source: string; language: string };

function available(): boolean {
	return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
}

/** The code blocks a highlighter can colour, with their text and language. */
function named(editor: LexicalEditor): Block[] {
	let found: Block[] = [];
	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isCodeBlockNode(child)) {
					let language = child.getLanguage().toLowerCase();
					if (kindOf(language) === "code") {
						found.push({ key: child.getKey(), source: child.getTextContent(), language });
					}
				} else if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});
	return found;
}

export function CodePaintPlugin() {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		if (!available()) return;
		let painted = new Map<string, Painted>();
		let roles = new Set<string>();
		let live = true;

		let publish = () => {
			let all = new Map<string, Range[]>();
			for (let block of painted.values()) {
				for (let [role, list] of block.byRole) {
					all.set(role, [...all.get(role) ?? [], ...list]);
				}
			}
			for (let role of new Set([...roles, ...all.keys()])) {
				paintShared(PREFIX + role, editor, all.get(role) ?? []);
			}
			roles = new Set(all.keys());
		};

		let styled = false;
		let paint = () => {
			if (!live) return;
			let blocks = named(editor);
			// The colours and the code's lane arrive with the first block that names a language, as
			// the highlighter does: a document without code pays for neither.
			if (blocks.length && !styled) {
				styled = true;
				void import("./code-paint.css");
			}
			let changed = false;
			let seen = new Set<string>();
			for (let block of blocks) {
				seen.add(block.key);
				let element = editor.getElementByKey(block.key)?.querySelector<HTMLElement>(
					"[data-plan-source]",
				);
				let before = painted.get(block.key);
				if (
					before && element === before.element && before.source === block.source
					&& before.language === block.language && before.nodes.every(node => node.isConnected)
				) {
					continue;
				}
				let tokenize = loadedTokenizer(block.language);
				let text = element && tokenize ? pieces(element, block.source) : undefined;
				if (!element || !tokenize || !text) {
					if (before) {
						painted.delete(block.key);
						changed = true;
					}
					// The grammar arrives later and paints the block then.
					if (!tokenize) {
						void loadTokenizer(block.language).then(found => {
							if (found) paint();
						}, () => {});
					}
					continue;
				}
				let held = before?.language === block.language ? before.held : undefined;
				let coloured = colour(tokenize, block.source, held);
				painted.set(block.key, {
					element,
					source: block.source,
					language: block.language,
					held: coloured.held,
					nodes: text.map(piece => piece.node),
					byRole: ranges(text, spans(coloured.lines)),
				});
				changed = true;
			}
			for (let key of painted.keys()) {
				if (seen.has(key)) continue;
				painted.delete(key);
				changed = true;
			}
			if (changed) publish();
		};

		paint();
		let off = editor.registerUpdateListener(paint);
		return () => {
			live = false;
			off();
			painted.clear();
			publish();
		};
	}, [editor]);

	return null;
}
