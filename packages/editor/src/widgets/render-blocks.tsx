/**
 * Rendered previews for code, math and diagrams.
 *
 * These blocks keep their source as collaborative text children, so the source
 * stays editable and merges per character. Rendering is layered over that model
 * rather than replacing it: a preview is attached beside the source, never in
 * place of the nodes Yjs is synchronising.
 *
 * KaTeX, Mermaid and the code renderer are loaded on demand — most plans
 * contain none of them, and each is large enough that paying for it up front is
 * not justified.
 *
 * Everything in the preview slot is put there by React, including the markup
 * KaTeX and Mermaid produce as strings. Two writers in one element is the
 * trap: a block whose language changes keeps its element, and an effect that
 * cleared the slot on the way out would run *after* React had already
 * committed the next renderer's nodes into it, taking them with it. One owner
 * means switching from a diagram to a fence is a reconciliation rather than a
 * race.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COLLABORATION_TAG,
	HISTORIC_TAG,
} from "lexical";
import { $isCodeBlockNode, $isMathNode } from "@chopin/dialect";

import { enclosing, remember } from "../collapse";
import { kindOf, LANGUAGES } from "./code";
import { CodeView } from "./code-view";

import type { ElementNode, LexicalEditor } from "lexical";
import type { Kind } from "./code";

type Block = {
	key: string;
	kind: Kind | "math";
	inline: boolean;
	source: string;
	/** Empty for math, and for a fence nobody has named. */
	language: string;
	meta: string;
};

/** Whether a block has a second reading of itself to show. */
function renders(block: Block, html: string | undefined): boolean {
	if (!block.source.trim()) return false;
	if (block.kind === "math" || block.kind === "mermaid") return !!html;
	return block.kind === "code" || block.kind === "diff";
}

function collect(editor: LexicalEditor): Block[] {
	let blocks: Block[] = [];

	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isMathNode(child)) {
					blocks.push({
						key: child.getKey(),
						kind: "math",
						inline: child.isInlineMath(),
						source: child.getTextContent(),
						language: "",
						meta: child.getMeta(),
					});
				} else if ($isCodeBlockNode(child)) {
					let language = child.getLanguage();
					blocks.push({
						key: child.getKey(),
						kind: kindOf(language),
						inline: false,
						source: child.getTextContent(),
						language,
						meta: child.getMeta(),
					});
				}
				if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});

	return blocks;
}

async function renderMath(source: string, inline: boolean): Promise<string> {
	// The stylesheet is not decoration: KaTeX emits bare spans and leaves every
	// fraction bar, radical and glyph to CSS, so without it a formula renders as
	// scrambled text. Loaded beside the library rather than up front, and the
	// bundler resolves its fonts on the way.
	let [katex] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
	return katex.default.renderToString(source, {
		displayMode: !inline,
		// Untrusted input: never let a formula emit markup or navigate.
		trust: false,
		strict: false,
		throwOnError: false,
		output: "html",
	});
}

async function renderMermaid(key: string, source: string): Promise<string> {
	let mermaid = await import("mermaid");
	mermaid.default.initialize({
		startOnLoad: false,
		// Its own error drawing is a temporary full-page SVG appended to body,
		// and a parse failure throws before Mermaid removes it. The preview below
		// already presents the error beside the source that caused it.
		suppressErrorRendering: true,
		// Diagrams come from collaborators and agents, so scripts, click
		// handlers and HTML labels stay off.
		securityLevel: "strict",
		htmlLabels: false,
		theme: "neutral",
	});
	let { svg } = await mermaid.default.render(`ace-mermaid-${key}`, source);
	let parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
	let root = parsed.documentElement;
	let viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
	if (root.localName !== "svg" || viewBox?.length !== 4) return svg;
	let width = viewBox[2]!;
	let height = viewBox[3]!;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return svg;
	}

	/*
	 * Mermaid writes `width="100%"` and an inline maximum from this viewBox.
	 * In prose that makes a wide diagram shrink until its labels are unreadable.
	 * Give the SVG its authored drawing size instead; the preview owns overflow
	 * and normal document flow owns height after every render and resize.
	 */
	root.setAttribute("width", String(width));
	root.setAttribute("height", String(height));
	root.style.removeProperty("max-width");
	if (!root.getAttribute("style")) root.removeAttribute("style");
	return root.outerHTML;
}

/**
 * What a fence is, changed from the block itself.
 *
 * The language is an attribute rather than content, so it is edited through a
 * control rather than by typing — the same arrangement a callout's type has,
 * and for the same reason: the fence markers are not in the document, so there
 * is nowhere to type it. A language the list does not offer is kept and shown,
 * because the agent may well have written one and losing it on the first
 * glance at the menu would be an edit nobody asked for.
 */
function Language(
	{ block, editor, disabled }: { block: Block; editor: LexicalEditor; disabled?: boolean },
) {
	let set = useCallback((language: string) => {
		editor.update(() => {
			let node = $getNodeByKey(block.key);
			if (!$isCodeBlockNode(node)) return;
			node.setLanguage(language);
			// Markdown writes an info string after a language, so meta cannot
			// outlive one. The node enforces this on creation; changing the
			// language later reaches the same rule from the other side.
			if (!language) node.setMeta("");
		});
	}, [editor, block.key]);

	let listed = LANGUAGES.some(([id]) => id === block.language);

	return (
		<select
			aria-label="Code language"
			value={block.language}
			disabled={disabled}
			onChange={event => set(event.currentTarget.value)}
			className="field-ghost cursor-pointer px-1 text-sm text-text-quaternary"
		>
			<option value="">Plain text</option>
			{!listed && block.language && <option value={block.language}>{block.language}</option>}
			{LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
		</select>
	);
}

function Toggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-expanded={!collapsed}
			onClick={onToggle}
			// Clicking a non-editable island inside a contenteditable makes
			// the browser place the caret at the nearest editable position,
			// which is the source this is about to hide. The selection
			// change arrives asynchronously, after the collapse, and reads
			// as the reader arrowing in — reopening what they just closed.
			onMouseDown={event => event.preventDefault()}
			className="cursor-pointer rounded-sm px-1.5 py-0.5 text-sm text-text-tertiary transition hover:bg-hover hover:text-text-primary"
		>
			{collapsed ? "Show source" : "Hide source"}
		</button>
	);
}

/** Attaches a preview element beside a block's source, keyed to its content. */
function Preview(
	{ block, editor, collapsed, disabled, onToggle, onHidable }: {
		block: Block;
		editor: LexicalEditor;
		collapsed: boolean;
		disabled?: boolean;
		onToggle: () => void;
		onHidable: (key: string, hidable: boolean) => void;
	},
) {
	let [html, setHtml] = useState<string>();
	let [error, setError] = useState<string>();

	let drawn = block.kind === "math" || block.kind === "mermaid";

	useEffect(() => {
		// A block that stopped being a diagram must stop showing one. Its
		// element survives the change of language, and so would the last
		// drawing made from it — beside, or instead of, whatever the new
		// language renders.
		if (!drawn) {
			setHtml(undefined);
			setError(undefined);
			return;
		}
		let cancelled = false;

		let run = async () => {
			if (!block.source.trim()) {
				setHtml(undefined);
				return;
			}
			try {
				let out = block.kind === "math"
					? await renderMath(block.source, block.inline)
					: await renderMermaid(block.key, block.source);
				if (cancelled) return;
				setHtml(out);
				setError(undefined);
			} catch (err) {
				if (cancelled) return;
				setHtml(undefined);
				setError(err instanceof Error ? err.message : "could not be rendered");
			}
		};

		void run();
		return () => {
			cancelled = true;
		};
	}, [drawn, block.key, block.kind, block.inline, block.source]);

	/*
	 * Hiding is applied to the DOM, never to the document: the source is still
	 * there, still synchronised, still someone else's to edit.
	 *
	 * Rewritten on every commit rather than only when it changes. Lexical
	 * replaces the element whenever `updateDOM` returns true — a code block
	 * changing language, math flipping inline — which would drop the attribute
	 * while this still believed it had been set.
	 */
	let hide = collapsed && renders(block, html);
	useEffect(() => {
		let element = editor.getElementByKey(block.key);
		if (!element) return;
		if (hide) element.dataset.planCollapsed = "";
		else delete element.dataset.planCollapsed;
	});

	let element = editor.getElementByKey(block.key);
	let host = element?.querySelector<HTMLElement>("[data-plan-preview]");
	let chrome = element?.querySelector<HTMLElement>("[data-plan-chrome='block']");

	// A block with nothing rendered has nothing to fall back to, so there is
	// nothing to offer: hiding a plain fence would leave an empty box. A
	// formula has no language either, so its row can be empty of both.
	let hidable = renders(block, html);
	let named = block.kind !== "math";

	useEffect(() => {
		onHidable(block.key, hidable);
		return () => onHidable(block.key, false);
	}, [block.key, hidable, onHidable]);

	// These portals are siblings, so their stable keys also need distinct roles.
	return (
		<>
			{host
				&& createPortal(
					<Rendered block={block} html={html} error={error} />,
					host,
					`${block.key}:preview`,
				)}
			{chrome && (hidable || named) && createPortal(
				<div
					// Chrome, not content: keep it out of the editable tree.
					contentEditable={false}
					className="flex items-center justify-between gap-2"
				>
					{named ? <Language block={block} editor={editor} disabled={disabled} /> : <span />}
					{hidable && <Toggle collapsed={collapsed} onToggle={onToggle} />}
				</div>,
				chrome,
				`${block.key}:chrome`,
			)}
		</>
	);
}

function Rendered(
	{ block, html, error }: { block: Block; html: string | undefined; error: string | undefined },
) {
	if (error) return <div data-plan-error="">{error}</div>;
	if (!block.source.trim()) return null;

	if (block.kind === "code" || block.kind === "diff") {
		return (
			<CodeView
				kind={block.kind}
				source={block.source}
				language={block.language}
				meta={block.meta}
			/>
		);
	}

	if (!html) return null;
	if (block.kind === "mermaid") {
		return (
			<div
				aria-label="Diagram preview"
				className="plan-diagram"
				role="region"
				tabIndex={0}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}

	// Produced by KaTeX from validated source under its strict mode, not by
	// anything the author wrote.
	//
	// Inline math is a span inside a sentence, so what wraps it has to be one
	// too: a block element here would put a formula somebody wrote mid-clause
	// on a line of its own, and the rest of the sentence after it.
	if (block.inline) return <span dangerouslySetInnerHTML={{ __html: html }} />;
	return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export function PreviewPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [blocks, setBlocks] = useState<Block[]>([]);
	/** Blocks this viewer explicitly chose to reveal. */
	let [shown, setShown] = useState<Record<string, boolean>>({});
	/** Blocks that currently have a rendered preview. */
	let [hidable, setHidable] = useState<ReadonlySet<string>>(() => new Set());

	/** Read by listeners that must not re-register whenever one is toggled. */
	let current = useRef(shown);
	current.current = shown;

	let reportHidable = useCallback((key: string, value: boolean) => {
		setHidable(previous => {
			if (previous.has(key) === value) return previous;
			let next = new Set(previous);
			if (value) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);

	useEffect(() => {
		let update = () => setBlocks(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	// The painter of remote cursors cannot see React state, and needs this.
	useEffect(() => {
		remember(
			editor,
			new Set([...hidable].filter(key => !shown[key])),
		);
	}, [editor, hidable, shown]);

	/*
	 * Arrowing into a hidden block opens it.
	 *
	 * The source is the block's only editable region, so leaving it hidden with
	 * the caret inside would mean typing into somewhere invisible. A tab strip
	 * never has to deal with this — a hidden panel is never the selection.
	 */
	useEffect(() => {
		return editor.registerUpdateListener(({ tags }) => {
			// Someone else's edit is not this reader navigating. Remote changes
			// can recover the local selection into a block, and that should not
			// reopen one they chose to close.
			if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) return;
			editor.getEditorState().read(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				let key = enclosing(selection.anchor.getNode());
				if (!key || current.current[key]) return;
				setShown(prev => ({ ...prev, [key]: true }));
			});
		});
	}, [editor]);

	let toggle = useCallback((key: string) => {
		// Collapsing with the caret inside would strand it in a hidden box, so
		// it is moved past the block first.
		let collapsed = !current.current[key];
		if (!collapsed) {
			editor.update(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				if (enclosing(selection.anchor.getNode()) !== key) return;
				$getNodeByKey(key)?.selectNext(0, 0);
			});
		}
		setShown(prev => ({ ...prev, [key]: collapsed }));
	}, [editor]);

	return (
		<>
			{blocks.map(block => (
				<Preview
					key={block.key}
					block={block}
					editor={editor}
					collapsed={!shown[block.key]}
					disabled={disabled}
					onToggle={() => toggle(block.key)}
					onHidable={reportHidable}
				/>
			))}
		</>
	);
}
