/**
 * Rendered previews for code, math and diagrams.
 *
 * These blocks keep their source as collaborative text children, so the source
 * stays editable and merges per character. Rendering is layered over that model
 * rather than replacing it: a preview is attached beside the source, never in
 * place of the nodes Yjs is synchronising.
 *
 * KaTeX and Mermaid are loaded on demand — most plans contain neither, and both
 * are large enough that paying for them up front is not justified.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COLLABORATION_TAG,
	HISTORIC_TAG,
} from "lexical";
import { $isCodeBlockNode, $isMathNode, MERMAID_LANGUAGE } from "@chopin/dialect";

import { enclosing, remember } from "../collapse";

import type { ElementNode, LexicalEditor } from "lexical";

type Block = {
	key: string;
	kind: "math" | "mermaid";
	inline: boolean;
	source: string;
};

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
					});
				} else if ($isCodeBlockNode(child) && child.getLanguage() === MERMAID_LANGUAGE) {
					blocks.push({
						key: child.getKey(),
						kind: "mermaid",
						inline: false,
						source: child.getTextContent(),
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
		// Diagrams come from collaborators and agents, so scripts, click
		// handlers and HTML labels stay off.
		securityLevel: "strict",
		htmlLabels: false,
		theme: "neutral",
	});
	let { svg } = await mermaid.default.render(`ace-mermaid-${key}`, source);
	return svg;
}

function Toggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
	return (
		<div
			// Chrome, not content: keep it out of the editable tree.
			contentEditable={false}
			className="flex justify-end"
		>
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
				className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				{collapsed ? "Show source" : "Hide source"}
			</button>
		</div>
	);
}

/** Attaches a preview element beside a block's source, keyed to its content. */
function Preview(
	{ block, editor, collapsed, onToggle }: {
		block: Block;
		editor: LexicalEditor;
		collapsed: boolean;
		onToggle: () => void;
	},
) {
	let [html, setHtml] = useState<string>();
	let [error, setError] = useState<string>();

	useEffect(() => {
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
	}, [block.key, block.kind, block.inline, block.source]);

	useEffect(() => {
		let element = editor.getElementByKey(block.key);
		let host = element?.querySelector<HTMLElement>("[data-plan-preview]");
		if (!host) return;

		if (error) {
			host.textContent = error;
			host.dataset.planError = "";
			return;
		}

		delete host.dataset.planError;
		// The rendered output is produced by KaTeX/Mermaid from validated
		// source under their strict modes, not by anything the author wrote.
		host.innerHTML = html ?? "";
	}, [editor, block.key, html, error]);

	/*
	 * Hiding is applied to the DOM, never to the document: the source is still
	 * there, still synchronised, still someone else's to edit.
	 *
	 * Rewritten on every commit rather than only when it changes. Lexical
	 * replaces the element whenever `updateDOM` returns true — a code block
	 * changing language, math flipping inline — which would drop the attribute
	 * while this still believed it had been set.
	 */
	let hide = collapsed && !!html;
	useEffect(() => {
		let element = editor.getElementByKey(block.key);
		if (!element) return;
		if (hide) element.dataset.planCollapsed = "";
		else delete element.dataset.planCollapsed;
	});

	// A block with nothing rendered has nothing to fall back to, so there is
	// nothing to offer: hiding a plain fence would leave an empty box.
	let host = html
		? editor.getElementByKey(block.key)?.querySelector<HTMLElement>("[data-plan-chrome='block']")
		: undefined;
	if (!host) return null;

	return createPortal(<Toggle collapsed={collapsed} onToggle={onToggle} />, host, block.key);
}

export function PreviewPlugin() {
	let [editor] = useLexicalComposerContext();
	let [blocks, setBlocks] = useState<Block[]>([]);
	/** Blocks showing only their result. Local to this viewer, and to this session. */
	let [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	/** Read by listeners that must not re-register whenever one is toggled. */
	let current = useRef(collapsed);
	current.current = collapsed;

	useEffect(() => {
		let update = () => setBlocks(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	// The painter of remote cursors cannot see React state, and needs this.
	useEffect(() => {
		remember(
			editor,
			new Set(Object.keys(collapsed).filter(key => collapsed[key])),
		);
	}, [editor, collapsed]);

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
				if (!key || !current.current[key]) return;
				setCollapsed(prev => ({ ...prev, [key]: false }));
			});
		});
	}, [editor]);

	let toggle = useCallback((key: string) => {
		// Collapsing with the caret inside would strand it in a hidden box, so
		// it is moved past the block first.
		if (!current.current[key]) {
			editor.update(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				if (enclosing(selection.anchor.getNode()) !== key) return;
				$getNodeByKey(key)?.selectNext(0, 0);
			});
		}
		setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
	}, [editor]);

	return (
		<>
			{blocks.map(block => (
				<Preview
					key={block.key}
					block={block}
					editor={editor}
					collapsed={!!collapsed[block.key]}
					onToggle={() => toggle(block.key)}
				/>
			))}
		</>
	);
}
