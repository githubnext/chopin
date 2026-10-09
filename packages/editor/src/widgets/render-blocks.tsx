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

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getNearestNodeFromDOMNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isDecoratorNode,
	$isElementNode,
	$isRangeSelection,
	$isRootNode,
	$isTextNode,
	$setSelection,
	BLUR_COMMAND,
	COLLABORATION_TAG,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_LOW,
	COMMAND_PRIORITY_NORMAL,
	COPY_COMMAND,
	FOCUS_COMMAND,
	HISTORIC_TAG,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_DOWN_COMMAND,
	KEY_ESCAPE_COMMAND,
	mergeRegister,
} from "lexical";
import { $isTableCellNode, $isTableRowNode } from "@lexical/table";
import { $isCodeBlockNode, $isMathNode } from "@chopin/dialect";

import { enclosing, remember } from "../collapse";
import { describeDiagramError, kindOf, languageOptions, plainText, titleOf } from "./code";
import { CodeView } from "./code-view";
import { LanguageMenu } from "./language-menu";
import { registerPreviewSelection } from "./preview-selection";
import { diffSourceLine, lastLineStart, offsetOfLine } from "./source-offset";
import { CodeIcon, WarningIcon } from "@chopin/icons";

import type { ElementNode, LexicalCommand, LexicalEditor, LexicalNode } from "lexical";
import type { Wireframe as WireframeTree } from "@chopin/diagrams/wireframe";
import type { Kind } from "./code";

/** How long the source must sit still before a failed drawing is reported. */
const ERROR_DELAY = 600;

/** Below this, a scaled-down diagram's labels stop being comfortably legible. */
const MIN_DIAGRAM_SCALE = 0.75;

type Block = {
	key: string;
	kind: Kind | "math";
	inline: boolean;
	source: string;
	/** Empty for math, and for a fence nobody has named. */
	language: string;
	meta: string;
};

const SeeCodeDiagram = lazy(() =>
	import("@chopin/diagrams/react").then(({ Diagram }) => ({ default: Diagram }))
);

const WireframeView = lazy(() =>
	import("@chopin/diagrams/wireframe/view").then(({ Wireframe }) => ({ default: Wireframe }))
);

/** A wireframe and the exact source it was drawn from. */
type Drawing = { source: string; wireframe: WireframeTree };

/** Whether a block has a second reading of itself to show. */
function renders(
	block: Block,
	html: string | undefined,
	spec: unknown,
	drawing?: Drawing,
): boolean {
	if (!block.source.trim()) return false;
	if (block.kind === "seecode") return spec !== undefined;
	if (block.kind === "wireframe") return drawing?.source === block.source;
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
	let [mermaid, { mermaidConfig, refineDiagram }] = await Promise.all([
		import("mermaid"),
		import("./mermaid-theme"),
	]);
	mermaid.default.initialize(mermaidConfig());
	let { svg } = await mermaid.default.render(`ace-mermaid-${key}`, source);

	/*
	 * The theme's last touches measure the drawing, which only works in a
	 * laid-out document. Stage a hidden copy, refine it, and keep the result
	 * as a string: the preview slot has a single owner, and it takes markup.
	 */
	let stage = document.createElement("div");
	stage.setAttribute("aria-hidden", "true");
	stage.style.position = "fixed";
	stage.style.visibility = "hidden";
	stage.style.pointerEvents = "none";
	stage.innerHTML = svg;
	document.body.append(stage);
	let root = stage.querySelector("svg");
	try {
		if (!root) return svg;
		refineDiagram(root);
	} finally {
		stage.remove();
	}

	let viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
	if (viewBox?.length !== 4) return root.outerHTML;
	let width = viewBox[2]!;
	let height = viewBox[3]!;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return root.outerHTML;
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

	let options = languageOptions(block.language);

	// A reader cannot change it, so it is a label rather than a disabled control.
	if (disabled) {
		let label = options.find(([id]) => id === block.language)?.[1] ?? block.language;
		return <span className="plan-code-language-label">{label}</span>;
	}

	return <LanguageMenu onChange={set} options={options} value={block.language} />;
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
			aria-label={collapsed ? "Show source" : "Hide source"}
			className="plan-code-toggle btn btn-icon btn-ghost"
			data-tooltip={collapsed ? "Show source" : "Hide source"}
		>
			<CodeIcon aria-hidden="true" size={14} />
		</button>
	);
}

/** Attaches a preview element beside a block's source, keyed to its content. */
function Preview(
	{ block, editor, collapsed, disabled, editing, onToggle, onHidable }: {
		block: Block;
		editor: LexicalEditor;
		collapsed: boolean;
		disabled?: boolean;
		/** The caret is in this block's source and the editor has focus. */
		editing: boolean;
		onToggle: () => void;
		onHidable: (key: string, hidable: boolean) => void;
	},
) {
	let [html, setHtml] = useState<string>();
	let [error, setError] = useState<string>();
	let [spec, setSpec] = useState<unknown>();
	let [drawing, setDrawing] = useState<Drawing>();
	/** The wireframe source that last failed to parse. */
	let [failed, setFailed] = useState<string>();

	let drawn = block.kind === "math" || block.kind === "mermaid" || block.kind === "seecode"
		|| block.kind === "wireframe";

	useEffect(() => {
		// A block that stopped being a diagram must stop showing one. Its
		// element survives the change of language, and so would the last
		// drawing made from it — beside, or instead of, whatever the new
		// language renders.
		if (!drawn) {
			setHtml(undefined);
			setError(undefined);
			setSpec(undefined);
			setDrawing(undefined);
			setFailed(undefined);
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (block.kind === "seecode") setSpec(undefined);

		let run = async () => {
			if (!block.source.trim()) {
				setHtml(undefined);
				setError(undefined);
				setDrawing(undefined);
				setFailed(undefined);
				return;
			}
			try {
				if (block.kind === "wireframe") {
					// The view is fetched beside the parser so it is ready by the
					// time there is something to draw.
					let [{ describeWireframeProblem, parseWireframe }] = await Promise.all([
						import("@chopin/diagrams/wireframe"),
						import("@chopin/diagrams/wireframe/view"),
					]);
					let parsed = parseWireframe(block.source);
					if (cancelled) return;
					if (!parsed.ok) throw new Error(describeWireframeProblem(parsed.problems));
					setDrawing({ source: block.source, wireframe: parsed.wireframe });
					setFailed(undefined);
					setError(undefined);
					return;
				}
				if (block.kind === "seecode") {
					let { parseDiagramSource, renderDiagram } = await import("@chopin/diagrams");
					let parsed = parseDiagramSource(block.source);
					if (!parsed.ok) throw new Error(parsed.message);
					let rendered = renderDiagram(parsed.spec);
					if (!rendered.ok) {
						let problem = rendered.problems[0];
						throw new Error(
							problem
								? `${problem.at === "(root)" ? "" : `${problem.at}: `}${problem.msg}`.slice(0, 240)
								: "Diagram specification is invalid.",
						);
					}
					if (cancelled) return;
					setSpec(parsed.spec);
					setError(undefined);
					return;
				}
				let out = block.kind === "math"
					? await renderMath(block.source, block.inline)
					: await renderMermaid(block.key, block.source);
				if (cancelled) return;
				setHtml(out);
				setError(undefined);
			} catch (err) {
				if (cancelled) return;
				// Half-typed source fails on nearly every keystroke. Keep the last
				// drawing and only say what is wrong once the author pauses.
				let message = err instanceof Error ? err.message : "could not be rendered";
				if (block.kind === "seecode") setSpec(undefined);
				else if (block.kind === "math") setHtml(undefined);
				else if (block.kind === "wireframe") setFailed(block.source);
				timer = setTimeout(() => setError(message), ERROR_DELAY);
			}
		};

		void run();
		return () => {
			cancelled = true;
			clearTimeout(timer);
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
	 *
	 * A layout effect, because opening a block and putting the caret in its
	 * source happen in one gesture, and a caret cannot land in a hidden box.
	 *
	 * Code and diffs swap: their preview is the same text, coloured, so
	 * showing both would put every line on screen twice. A drawing is a
	 * different reading of its source, and stays above it while it is edited.
	 */
	let text = plainText(block.language);
	let current = renders(block, html, spec, drawing);
	/*
	 * A wireframe keeps its last drawing while a changed source is still being
	 * read, so nobody's edit flickers it to code and back. One somebody is
	 * writing keeps it, faded, while the source does not parse; one nobody is
	 * in that does not parse is plain code.
	 */
	let broken = block.kind === "wireframe" && failed === block.source;
	let pending = block.kind === "wireframe" && !current && !broken && drawing !== undefined;
	let stale = broken && !collapsed && drawing !== undefined;
	let wireframe = block.kind === "wireframe" && (current || pending || stale);
	let hide = collapsed && (current || pending);
	let swap = !collapsed && current && (block.kind === "code" || block.kind === "diff");
	useEffect(() => {
		if (broken && collapsed && drawing) setDrawing(undefined);
	}, [broken, collapsed, drawing]);
	useLayoutEffect(() => {
		let element = editor.getElementByKey(block.key);
		if (!element) return;
		if (hide) element.dataset.planCollapsed = "";
		else delete element.dataset.planCollapsed;
		if (swap) element.dataset.planSwapped = "";
		else delete element.dataset.planSwapped;
		if (hide && block.kind === "seecode") element.dataset.planPresentation = "diagram";
		else if (wireframe) element.dataset.planPresentation = "wireframe";
		else delete element.dataset.planPresentation;
		if (text) element.dataset.planText = "";
		else delete element.dataset.planText;
		if (wireframe && editing) element.dataset.planEditing = "";
		else delete element.dataset.planEditing;
	});

	let element = editor.getElementByKey(block.key);
	let host = element?.querySelector<HTMLElement>("[data-plan-preview]");
	// A wireframe is chromeless: the caret going in is the way to its source.
	let chrome = block.kind === "wireframe"
		? undefined
		: element?.querySelector<HTMLElement>("[data-plan-chrome='block']");

	// A block with nothing rendered has nothing to fall back to, so there is
	// nothing to offer: hiding a plain fence would leave an empty box. A
	// formula has no language either, so its row can be empty of both.
	let hidable = current || pending;
	let named = block.kind !== "math";

	useEffect(() => {
		onHidable(block.key, hidable);
		return () => onHidable(block.key, false);
	}, [block.key, hidable, onHidable]);

	let title = block.kind !== "diff" ? titleOf(block.meta) : undefined;

	// These portals are siblings, so their stable keys also need distinct roles.
	return (
		<>
			{host
				&& createPortal(
					<Rendered
						block={block}
						html={html}
						error={error}
						spec={spec}
						drawing={wireframe ? drawing : undefined}
						stale={stale}
					/>,
					host,
					`${block.key}:preview`,
				)}
			{chrome && (hidable || named) && !(block.kind === "seecode" && hidable) && createPortal(
				<div
					// Chrome, not content: keep it out of the editable tree.
					contentEditable={false}
					className="plan-code-chrome flex min-w-0 items-center gap-1"
					// The block clips its corners, so controls draw focus inside themselves.
					data-focus-boundary=""
					data-kind={block.kind}
					// The caret lives in the editor root, so `:focus-within` never
					// sees it; this is what reveals the controls while typing.
					data-editing={editing ? "" : undefined}
				>
					{
						// Tab indents code, so the way out has to be said
						// where someone is typing it. A block with a preview
						// returns to it on Escape, and Tab leaves from there.
						editing && !disabled && block.kind !== "math" && (
							<span className="text-xs text-text-tertiary">
								{hidable ? "Esc to preview" : "Esc then Tab to leave"}
							</span>
						)
					}
					{hidable && <Toggle collapsed={collapsed} onToggle={onToggle} />}
					{title && <span className="plan-code-title">{title}</span>}
					{named && <Language block={block} editor={editor} disabled={disabled} />}
				</div>,
				chrome,
				`${block.key}:chrome`,
			)}
		</>
	);
}

/**
 * Not a live region: the diagram re-renders on every keystroke, and each
 * intermediate error would be announced.
 *
 * The parser's list of expected tokens is left out: the excerpt already points
 * at the place, and the token names mean nothing to someone drawing a chart.
 */
function DiagramError({ message }: { message: string }) {
	let { summary, excerpt } = describeDiagramError(message);
	return (
		<div data-plan-error="">
			<span aria-hidden="true" className="plan-error-badge">
				<WarningIcon size={14} />
			</span>
			<div className="plan-error-text">
				<strong className="plan-error-title">This diagram could not be drawn</strong>
				<p className="plan-error-message">{summary}</p>
				{excerpt && <pre className="plan-error-detail">{excerpt}</pre>}
			</div>
		</div>
	);
}

/** Which sides of a scroller still hide some of the drawing. */
function hiddenSides(element: HTMLElement): "start" | "end" | "both" | undefined {
	let start = element.scrollLeft > 1;
	let end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
	if (start && end) return "both";
	return start ? "start" : end ? "end" : undefined;
}

/**
 * A drawn diagram in its own horizontal scroller.
 *
 * Mermaid lays text out at its authored size, so shrinking a wide chart to the
 * measure makes its labels unreadable. A modest overshoot is scaled to fit;
 * anything wider keeps its size and scrolls, fading the side with more to see.
 */
function Diagram({ html, stale }: { html: string; stale: boolean }) {
	let region = useRef<HTMLDivElement>(null);
	let [fit, setFit] = useState(false);
	let [more, setMore] = useState<ReturnType<typeof hiddenSides>>();

	useEffect(() => {
		let element = region.current;
		let svg = element?.querySelector("svg");
		if (!element || !svg) return;
		let authored = Number(svg.getAttribute("width"));
		let measure = () => {
			let style = getComputedStyle(element);
			let room = element.clientWidth - parseFloat(style.paddingInlineStart)
				- parseFloat(style.paddingInlineEnd);
			setFit(!(authored > 0) || room >= authored * MIN_DIAGRAM_SCALE);
			setMore(hiddenSides(element));
		};
		let scrolled = () => setMore(hiddenSides(element));
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		element.addEventListener("scroll", scrolled, { passive: true });
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", scrolled);
		};
	}, [html]);

	// Fitting changes the drawing's width, so whether anything is hidden is
	// only known after that has been laid out.
	useEffect(() => {
		if (region.current) setMore(hiddenSides(region.current));
	}, [fit, html]);

	return (
		<div
			ref={region}
			aria-label="Diagram preview"
			className="plan-diagram"
			data-fit={fit ? "" : undefined}
			data-more={more}
			data-stale={stale ? "" : undefined}
			role="region"
			tabIndex={0}
			// Mermaid draws its labels as HTML. Inside the editable root, a
			// click would otherwise put a caret in a label and type into it.
			contentEditable={false}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/** Like a diagram's, but its message already names the line. */
function WireframeError({ message }: { message: string }) {
	return (
		<div data-plan-error="">
			<span aria-hidden="true" className="plan-error-badge">
				<WarningIcon size={14} />
			</span>
			<div className="plan-error-text">
				<strong className="plan-error-title">This wireframe could not be drawn</strong>
				<p className="plan-error-message">{message}</p>
			</div>
		</div>
	);
}

function Rendered(
	{ block, html, error, spec, drawing, stale }: {
		block: Block;
		html: string | undefined;
		error: string | undefined;
		spec: unknown;
		/** Only while it is shown: current, or the last one while its source is mid-edit. */
		drawing?: Drawing;
		/** The drawing is of an earlier source than the one that does not parse now. */
		stale?: boolean;
	},
) {
	if (block.kind === "wireframe") {
		return (
			<>
				{drawing && (
					<div
						className="plan-wireframe"
						contentEditable={false}
						data-stale={stale ? "" : undefined}
					>
						<Suspense fallback={null}>
							<WireframeView wireframe={drawing.wireframe} focusable />
						</Suspense>
					</div>
				)}
				{error && <WireframeError message={error} />}
			</>
		);
	}
	if (block.kind === "mermaid" && (html || error)) {
		return (
			<>
				{html && <Diagram html={html} stale={!!error} />}
				{error && <DiagramError message={error} />}
			</>
		);
	}
	if (error && block.kind === "seecode") return <DiagramError message={error} />;
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
	if (block.kind === "seecode") {
		if (spec === undefined) return null;
		return (
			<div
				className="plan-seecode"
				contentEditable={false}
				role="region"
				aria-label="Diagram preview"
				tabIndex={0}
			>
				<Suspense fallback={null}>
					<SeeCodeDiagram spec={spec} idPrefix={block.key} />
				</Suspense>
			</div>
		);
	}

	if (!html) return null;

	// Produced by KaTeX from validated source under its strict mode, not by
	// anything the author wrote.
	//
	// Inline math is a span inside a sentence, so what wraps it has to be one
	// too: a block element here would put a formula somebody wrote mid-clause
	// on a line of its own, and the rest of the sentence after it.
	if (block.inline) return <span dangerouslySetInnerHTML={{ __html: html }} />;
	return <div contentEditable={false} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Asked for with the toggle, or opened by going into the block. */
type Shown = "pinned" | "editing";

type Direction = "next" | "previous";

/** A collapsed caret at a text offset inside a block's source. */
function $caretAt(block: ElementNode, offset: number): void {
	let start = 0;
	for (let child of block.getChildren()) {
		let size = child.getTextContentSize();
		if ($isTextNode(child) && offset <= start + size) {
			child.select(offset - start, offset - start);
			return;
		}
		if (offset <= start) {
			let index = child.getIndexWithinParent();
			block.select(index, index);
			return;
		}
		start += size;
	}
	block.selectEnd();
}

type CaretPositionAt = (
	x: number,
	y: number,
	options?: { shadowRoots?: ShadowRoot[] },
) => { offsetNode: Node; offset: number } | null;

/** The character offset of a point inside one drawn line, if the browser can say. */
function columnAt(line: HTMLElement, x: number, y: number): number | undefined {
	let root = line.getRootNode();
	let at = (document as unknown as { caretPositionFromPoint?: CaretPositionAt })
		.caretPositionFromPoint?.(x, y, root instanceof ShadowRoot ? { shadowRoots: [root] } : {});
	if (!at || !line.contains(at.offsetNode)) return undefined;
	let column = 0;
	let walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node === at.offsetNode) return column + at.offset;
		column += node.textContent?.length ?? 0;
	}
	return undefined;
}

/**
 * Where a click on drawn code lands in its source.
 *
 * The renderer paints into shadow roots and marks each line, so the event's
 * composed path names the line. A file keeps the source's lines one for one; a
 * patch is matched line by line. Diagrams and formulas have no lines to map.
 */
function clickedOffset(block: Block, event: MouseEvent): number | undefined {
	if (block.kind !== "code" && block.kind !== "diff") return undefined;
	let path = event.composedPath();
	let marked = path.find((target): target is HTMLElement =>
		target instanceof HTMLElement
		&& (target.hasAttribute("data-line") || target.hasAttribute("data-column-number"))
	);
	let view = path.find((target): target is HTMLElement =>
		target instanceof HTMLElement && target.classList.contains("plan-code-view")
	);
	if (!marked || !view) return undefined;
	// A line number in a diff's gutter stands for the start of its line.
	let line = marked.hasAttribute("data-line")
		? marked
		: (marked.getRootNode() as ParentNode).querySelector<HTMLElement>(
			`[data-line][data-line-index="${marked.dataset.lineIndex}"]`,
		);
	if (!line) return undefined;
	let column = line === marked ? columnAt(line, event.clientX, event.clientY) ?? Infinity : 0;
	if (view.dataset.view !== "diff") {
		return offsetOfLine(block.source, Number(line.dataset.line) - 1, column);
	}

	let type = line.dataset.lineType ?? "";
	let text = line.textContent ?? "";
	let drawn = [...view.querySelectorAll("diffs-container")].flatMap(container => [
		...(container.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []),
	]);
	let before = drawn.slice(0, Math.max(0, drawn.indexOf(line)));
	let occurrence =
		before.filter(other => other.dataset.lineType === type && other.textContent === text).length;
	let index = diffSourceLine(block.source, type, text, occurrence);
	return index === undefined ? undefined : offsetOfLine(block.source, index, column + 1);
}

/** The caret's rectangle, and the height of the line it sits on. */
function caretLine(document: Document): { rect: DOMRect; height: number } | undefined {
	let selection = document.getSelection();
	if (!selection?.rangeCount) return undefined;
	let rects = selection.getRangeAt(0).getClientRects();
	let rect: DOMRect | undefined = rects[rects.length - 1];
	let node = selection.focusNode;
	let line = node instanceof Element ? node : node?.parentElement;
	// A collapsed range at an empty line has no rectangle; its line stands in.
	if (!rect || rect.height === 0) rect = line?.getBoundingClientRect();
	if (!rect || rect.height === 0 || !line) return undefined;
	// The caret's box is the font's, shorter than the line it sits on.
	return {
		rect,
		height: Math.max(rect.height, parseFloat(getComputedStyle(line).lineHeight) || 0),
	};
}

/**
 * Whether the caret is on the first or last line of a block.
 *
 * Measured, because only layout knows where a wrapped line ends.
 */
function atEdge(element: HTMLElement, direction: Direction): boolean {
	let caret = caretLine(element.ownerDocument);
	if (!caret) return false;
	let { rect, height } = caret;
	let box = element.getBoundingClientRect();
	return direction === "next" ? box.bottom - rect.bottom < height : rect.top - box.top < height;
}

/**
 * Whether no other line sits between the caret and a block it shares a parent
 * with, such as the text of a list item and the code under it.
 */
function besideBlock(element: HTMLElement, direction: Direction): boolean {
	let caret = caretLine(element.ownerDocument);
	if (!caret) return false;
	let { rect, height } = caret;
	let box = element.getBoundingClientRect();
	let style = getComputedStyle(element);
	return direction === "next"
		? box.top - rect.bottom < height + parseFloat(style.marginBlockStart)
		: rect.top - box.bottom < height + parseFloat(style.marginBlockEnd);
}

function $isInlineNode(node: LexicalNode): boolean {
	return ($isElementNode(node) || $isDecoratorNode(node)) ? node.isInline() : true;
}

/** Rows and cells are a table's layout, not blocks read one after another. */
function $isTablePart(node: LexicalNode): boolean {
	return $isTableRowNode(node) || $isTableCellNode(node);
}

/**
 * The block an arrow key reads next, across the containers that callouts and
 * list items make: the nearest sibling of the caret's line or of one of its
 * ancestors. `level` is the node that sibling sits beside.
 */
function $following(
	from: LexicalNode,
	direction: Direction,
	skipInline: boolean,
): { level: LexicalNode; node: LexicalNode } | undefined {
	let step = (node: LexicalNode) =>
		direction === "next" ? node.getNextSibling() : node.getPreviousSibling();
	for (
		let level: LexicalNode | null = from;
		level && !$isRootNode(level);
		level = level.getParent()
	) {
		if ($isTablePart(level)) continue;
		let node = step(level);
		if (skipInline) { while (node && $isInlineNode(node)) node = step(node); }
		if (node) return { level, node };
	}
	return undefined;
}

/** The first (or last) block inside a container, down to one that holds text. */
function $edgeBlock(
	node: LexicalNode,
	direction: Direction,
	folded: (key: string) => boolean,
): LexicalNode {
	let at = node;
	while ($isElementNode(at) && !folded(at.getKey())) {
		let child = direction === "next" ? at.getFirstChild() : at.getLastChild();
		if (!child || $isInlineNode(child)) break;
		at = child;
	}
	return at;
}

const WIREFRAME_PREVIEW = ".plan-wireframe > .wf";

/** Something a reader can hold focus on in place of a caret. */
const FOCUSABLE_PREVIEW = `.plan-code-view, .plan-diagram, .plan-seecode, ${WIREFRAME_PREVIEW}`;

export function PreviewPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [blocks, setBlocks] = useState<Block[]>([]);
	/** Blocks whose source this viewer is looking at, and why. */
	let [shown, setShown] = useState<Record<string, Shown>>({});
	/** Blocks that currently have a rendered preview. */
	let [hidable, setHidable] = useState<ReadonlySet<string>>(() => new Set());

	/** The code block holding the caret while the editor has focus. */
	let [editing, setEditing] = useState<string>();
	/** Read by listeners that must not re-register whenever one is toggled. */
	let current = useRef(shown);
	current.current = shown;
	/** A press that began on a preview, until its click has decided what it was. */
	let pressing = useRef(false);
	let latest = useRef({ blocks, hidable, disabled });
	latest.current = { blocks, hidable, disabled };

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
	 * The caret going into a hidden block opens it, and leaving closes it again.
	 *
	 * The source is the block's only editable region, so leaving it hidden with
	 * the caret inside would mean typing into somewhere invisible. A tab strip
	 * never has to deal with this — a hidden panel is never the selection.
	 *
	 * Only what the caret opened closes behind it. A source somebody asked to
	 * see with the toggle stays until they hide it.
	 */
	useEffect(() => {
		return editor.registerUpdateListener(({ tags }) => {
			// Someone else's edit is not this reader navigating. Remote changes
			// can recover the local selection into a block, and that should not
			// reopen one they chose to close.
			if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) return;
			// Pressing on a preview resolves to its block, but is a click or a
			// copy, not the caret arriving; the click decides what that opens.
			// While the press lasts the browser may report the selection in the
			// hidden source, so the press itself is what is checked first.
			if (pressing.current) return;
			let anchor = editor.getRootElement()?.ownerDocument.getSelection()?.anchorNode;
			let at = anchor instanceof Element ? anchor : anchor?.parentElement;
			if (at?.closest("[data-plan-preview]")) return;
			let key = editor.getEditorState().read(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection)) return undefined;
				return enclosing(selection.anchor.getNode()) ?? "";
			});
			// No caret is not somewhere else: the reader may be on a preview
			// or a control of the block they were editing.
			if (key === undefined) return;
			// A wireframe folded on blur stays folded until someone is back in
			// the editor, whatever else updates the document meanwhile.
			let root = editor.getRootElement();
			let away = root?.ownerDocument.activeElement !== root
				&& latest.current.blocks.some(block => block.key === key && block.kind === "wireframe");
			setShown(prev => {
				let next = { ...prev };
				let changed = false;
				for (let [other, why] of Object.entries(prev)) {
					if (why !== "editing" || other === key) continue;
					delete next[other];
					changed = true;
				}
				if (key && !prev[key] && !away) {
					next[key] = "editing";
					changed = true;
				}
				return changed ? next : prev;
			});
		});
	}, [editor]);

	/*
	 * Getting into a rendered block, and back out, without hunting for its
	 * toggle.
	 *
	 * A click on a preview opens the source with the caret where the click
	 * was, as near as the drawing can say. Arrowing up or down into a block
	 * puts the caret in code, and focus on a drawing, which takes Enter (or any
	 * typing) to edit and another arrow to move on. Escape from a source goes
	 * back to the preview, holding focus there.
	 *
	 * A focused preview is not an editable position, so Lexical's own handling
	 * of a key there would act on the caret it left behind somewhere else. Every
	 * key aimed at a preview stops here.
	 */
	useEffect(() => {
		let blockAt = (element: Element | null | undefined) =>
			element
				? latest.current.blocks.find(block =>
					!block.inline && editor.getElementByKey(block.key) === element
				)
				: undefined;
		let folded = (key: string) => latest.current.hidable.has(key) && !current.current[key];
		let root = () => editor.getRootElement();

		/** Show a source and put the caret in it. Runs inside an update. */
		let $open = (key: string, offset: number, typed?: string) => {
			// Synchronously, so the source is laid out before Lexical puts the
			// DOM selection in it at the end of this update.
			flushSync(() => setShown(prev => (prev[key] ? prev : { ...prev, [key]: "editing" })));
			root()?.focus({ preventScroll: true });
			let node = $getNodeByKey(key);
			if (!$isElementNode(node)) return;
			$caretAt(node, offset);
			let selection = $getSelection();
			if (typed && $isRangeSelection(selection)) selection.insertText(typed);
		};

		let $enter = (key: string, direction: Direction) => {
			let block = latest.current.blocks.find(candidate => candidate.key === key);
			if (!block) return;
			if (block.kind === "mermaid" || block.kind === "wireframe") {
				let preview = editor.getElementByKey(key)?.querySelector<HTMLElement>(
					block.kind === "mermaid" ? ".plan-diagram" : WIREFRAME_PREVIEW,
				);
				if (preview) {
					// No caret is left to close what it opened on the way here.
					$setSelection(null);
					flushSync(() =>
						setShown(prev => {
							let next = Object.fromEntries(
								Object.entries(prev).filter(([, why]) => why !== "editing"),
							);
							return Object.keys(next).length === Object.keys(prev).length ? prev : next;
						})
					);
					preview.focus();
					return;
				}
			}
			$open(key, direction === "next" ? 0 : lastLineStart(block.source));
		};

		let $leave = (key: string, direction: Direction) => {
			let node = $getNodeByKey(key);
			if (!node) return;
			let found = $following(node, direction, false);
			let land = found && $edgeBlock(found.node, direction, folded);
			if (land && folded(land.getKey())) return $enter(land.getKey(), direction);
			root()?.focus({ preventScroll: true });
			if ($isTextNode(land)) {
				if (direction === "next") land.select(0, 0);
				else land.select();
			} else if ($isElementNode(land)) {
				if (direction === "next") land.selectStart();
				else land.selectEnd();
			} else if (direction === "next") node.selectNext(0, 0);
			else node.selectPrevious();
		};

		let $close = (block: Block) => {
			let node = $getNodeByKey(block.key);
			let preview = editor.getElementByKey(block.key);
			if (block.kind === "math") node?.selectNext(0, 0);
			else $setSelection(null);
			flushSync(() =>
				setShown(prev => {
					let next = { ...prev };
					delete next[block.key];
					return next;
				})
			);
			preview?.querySelector<HTMLElement>(FOCUSABLE_PREVIEW)?.focus({ preventScroll: true });
		};

		let arrow = (command: LexicalCommand<KeyboardEvent>, direction: Direction) =>
			editor.registerCommand(
				command,
				event => {
					if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
					if (latest.current.disabled) return false;
					// The DOM's selection rather than Lexical's, which trails a
					// click by a task: an arrow pressed straight after one would
					// otherwise be measured from where the caret used to be.
					let dom = editor.getRootElement()?.ownerDocument.getSelection();
					if (!dom?.isCollapsed || !dom.focusNode) return false;
					let from = $getNearestNodeFromDOMNode(dom.focusNode);
					if (!from) return false;
					let found = $following(from, direction, true);
					if (!found) return false;
					let target = $edgeBlock(found.node, direction, folded);
					if (!folded(target.getKey())) return false;
					// A hidden source has no layout, so the browser's own move
					// would step right over the block. Only the caret's last
					// (or first) line may step into it.
					let level = editor.getElementByKey(found.level.getKey());
					let block = editor.getElementByKey(target.getKey());
					let edge = $isInlineNode(found.level)
						? block && besideBlock(block, direction)
						: level && atEdge(level, direction);
					if (!edge) return false;
					event.preventDefault();
					$enter(target.getKey(), direction);
					return true;
				},
				// Ahead of the table's own arrows, which select the end of
				// whatever precedes a table: a hidden source.
				COMMAND_PRIORITY_CRITICAL,
			);

		/** Measured on the way down, while the preview is still the one on screen. */
		let pressed: { x: number; y: number; offset: number | undefined } | undefined;
		let down = (event: MouseEvent) => {
			let target = event.target instanceof Element ? event.target : null;
			let block = blockAt(target?.closest("[data-plan-preview]")?.parentElement);
			if (block) pressing.current = true;
			pressed = {
				x: event.clientX,
				y: event.clientY,
				offset: block && clickedOffset(block, event),
			};
		};
		let click = (event: MouseEvent) => {
			if (event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
				return;
			}
			if (latest.current.disabled || !editor.isEditable()) return;
			// A drag or a double click is someone selecting text to copy.
			let moved = pressed
				&& Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4;
			if (moved || event.detail > 1) return;
			if (!(event.target instanceof Element) || event.target.closest("[data-plan-chrome]")) return;
			let block = blockAt(event.target.closest("[data-plan-preview]")?.parentElement);
			if (!block || !latest.current.hidable.has(block.key)) return;
			// SeeCode owns clicks for diagram interaction; focusing its preview
			// and pressing Enter opens the canonical source.
			if (block.kind === "seecode") return;
			let offset = pressed?.offset ?? block.source.length;
			editor.update(() => $open(block.key, offset));
		};

		// After the click that follows, which may not land on the editor at all.
		let up = () => setTimeout(() => (pressing.current = false));

		let attached: HTMLElement | null = null;
		let unselect: (() => void) | undefined;
		let detach = () => {
			unselect?.();
			unselect = undefined;
			attached?.removeEventListener("mousedown", down);
			attached?.removeEventListener("click", click);
			attached?.ownerDocument.removeEventListener("mouseup", up);
			attached = null;
		};

		return mergeRegister(
			editor.registerRootListener(next => {
				detach();
				attached = next;
				next?.addEventListener("mousedown", down);
				next?.addEventListener("click", click);
				next?.ownerDocument.addEventListener("mouseup", up);
				if (next) {
					unselect = registerPreviewSelection(
						next,
						target => {
							let block = blockAt(target.closest("[data-plan-preview]")?.parentElement);
							return block && block.kind !== "seecode"
								? target.closest<HTMLElement>(FOCUSABLE_PREVIEW)
								: null;
						},
					);
				}
			}),
			detach,
			editor.registerCommand(
				KEY_DOWN_COMMAND,
				event => {
					if (!(event.target instanceof Element)) return false;
					let preview = event.target.closest(FOCUSABLE_PREVIEW);
					let block = blockAt(preview?.closest("[data-plan-preview]")?.parentElement);
					if (!block) return false;
					if (block.kind === "seecode" && event.target !== preview) return false;
					if (event.metaKey || event.ctrlKey || event.altKey) return true;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						$leave(block.key, event.key === "ArrowDown" ? "next" : "previous");
					} else if (event.key === "Enter" || event.key === " ") {
						// Space too: on a focused box it would scroll the page.
						event.preventDefault();
						$open(block.key, block.source.length);
					} else if (event.key.length === 1) {
						event.preventDefault();
						$open(block.key, block.source.length, event.key);
					}
					return true;
				},
				COMMAND_PRIORITY_CRITICAL,
			),
			// Text selected in a preview is the browser's to copy; Lexical would
			// copy its own selection, left somewhere else in the document.
			editor.registerCommand(
				COPY_COMMAND,
				event =>
					event instanceof ClipboardEvent && event.target instanceof Element
					&& !!event.target.closest(FOCUSABLE_PREVIEW),
				COMMAND_PRIORITY_CRITICAL,
			),
			arrow(KEY_ARROW_DOWN_COMMAND, "next"),
			arrow(KEY_ARROW_UP_COMMAND, "previous"),
			editor.registerCommand(
				KEY_ESCAPE_COMMAND,
				event => {
					if (latest.current.disabled) return false;
					let selection = $getSelection();
					if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					let key = enclosing(selection.anchor.getNode());
					let block = key ? blockAt(editor.getElementByKey(key)) : undefined;
					if (!block || !latest.current.hidable.has(block.key)) return false;
					// Spent here: a comment preview open on the same passage would
					// otherwise also close, and send focus back to its marker.
					event?.preventDefault();
					event?.stopPropagation();
					$close(block);
					return true;
				},
				COMMAND_PRIORITY_NORMAL,
			),
		);
	}, [editor]);

	useEffect(() => {
		let refresh = () => {
			let root = editor.getRootElement();
			if (!root || root.ownerDocument.activeElement !== root) return setEditing(undefined);
			setEditing(
				editor.getEditorState().read(() => {
					let selection = $getSelection();
					if (!$isRangeSelection(selection)) return undefined;
					for (let at: LexicalNode | null = selection.anchor.getNode(); at; at = at.getParent()) {
						if ($isCodeBlockNode(at)) return at.getKey();
					}
					return undefined;
				}),
			);
		};
		refresh();
		return mergeRegister(
			editor.registerUpdateListener(refresh),
			editor.registerCommand(FOCUS_COMMAND, () => {
				refresh();
				// Back in the editor with the caret still in a wireframe that blur
				// folded: open it again, since that is where typing will go.
				let key = editor.getEditorState().read(() => {
					let selection = $getSelection();
					return $isRangeSelection(selection) ? enclosing(selection.anchor.getNode()) : undefined;
				});
				let block = key && latest.current.blocks.find(candidate => candidate.key === key);
				// The DOM's selection says whether a click is already taking the
				// caret somewhere else, which Lexical has not heard about yet.
				let anchor = editor.getRootElement()?.ownerDocument.getSelection()?.anchorNode;
				let inside = key && anchor && editor.getElementByKey(key)?.contains(anchor);
				if (key && inside && block && block.kind === "wireframe") {
					setShown(prev => (prev[key] ? prev : { ...prev, [key]: "editing" }));
				}
				return false;
			}, COMMAND_PRIORITY_LOW),
			editor.registerCommand(BLUR_COMMAND, () => {
				setEditing(undefined);
				// A wireframe's source is open only while someone is writing in
				// it, so leaving the editor folds it as leaving the block does. A
				// press on its drawing is the click deciding, not someone leaving.
				if (pressing.current) return false;
				setShown(prev => {
					let next = { ...prev };
					for (let [key, why] of Object.entries(prev)) {
						let block = latest.current.blocks.find(candidate => candidate.key === key);
						if (why === "editing" && block?.kind === "wireframe") delete next[key];
					}
					return Object.keys(next).length === Object.keys(prev).length ? prev : next;
				});
				return false;
			}, COMMAND_PRIORITY_LOW),
		);
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
		setShown(prev => {
			let next = { ...prev };
			if (collapsed) next[key] = "pinned";
			else delete next[key];
			return next;
		});
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
					editing={editing === block.key}
					onToggle={() => toggle(block.key)}
					onHidable={reportHidable}
				/>
			))}
		</>
	);
}
