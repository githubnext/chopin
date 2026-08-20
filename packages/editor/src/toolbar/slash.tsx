/**
 * Block insertion, driven by typing `/`.
 *
 * Everything inserts locally and immediately, including the components that
 * carry a durable id: a ULID has enough entropy that two clients cannot mint
 * the same one, so buying uniqueness with a server round trip would only make
 * the block appear later than the keystroke that asked for it.
 */

import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $copyBlockFormatIndent, $setBlocksType } from "@lexical/selection";
import {
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COLLABORATION_TAG,
	COMMAND_PRIORITY_LOW,
	HISTORIC_TAG,
	KEY_DOWN_COMMAND,
} from "lexical";
import {
	$createCalloutNode,
	$createCodeBlockNode,
	$createImageNode,
	$createMathNode,
	$createTabNode,
	$createTabsNode,
	DIFF_LANGUAGE,
	IMAGE_PROTOCOLS,
	MERMAID_LANGUAGE,
	ulid,
} from "@chopin/dialect";

import { $createTableNodeWithDimensions } from "@lexical/table";
import { $createParagraphNode, $createTextNode, $insertNodes } from "lexical";

import { askForUrl } from "./url";
import { placeSurface } from "./placement";
import {
	DIVIDER,
	editorSurfaceViewport,
	listenToEditorGeometry,
	nativeSelectionRect,
	ROW,
	SHELL,
} from "./surface";

import type { ElementNode, LexicalEditor } from "lexical";
import type { DOMRectLike, SurfacePlacement } from "./placement";

export type SlashCommand = {
	id: string;
	label: string;
	group: string;
	keywords: string[];
	run: (editor: LexicalEditor) => void;
};

/** Replace the current block, dropping the `/query` the user typed. */
function replace(editor: LexicalEditor, build: () => ElementNode) {
	editor.update(() => {
		let selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		$setBlocksType(selection, build);
	});
}

/** Keep the replaced block as a block inside the new container. */
function insertCallout(editor: LexicalEditor) {
	editor.update(() => {
		let selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		let body: ElementNode | undefined;

		$setBlocksType(
			selection,
			() => $createCalloutNode(ulid()),
			(previous, callout) => {
				let paragraph = $createParagraphNode();
				$copyBlockFormatIndent(previous, paragraph);
				paragraph.append(...previous.getChildren());
				callout.append(paragraph);
				body = paragraph;
			},
		);

		// An empty text child is normalised away after this update; anchor the
		// caret to its paragraph so the next character does not become a direct
		// child of the callout instead.
		if (body?.getTextContentSize() === 0) body.selectEnd();
	});
}

/**
 * What the menu offers.
 *
 * Only blocks markdown cannot type. Headings, quotes and lists have shortcuts
 * — `# `, `> `, `- `, `1. ` — and a control in the selection bubble, so listing
 * them here would be a third way to do what two already do, and would bury the
 * things that have no other route.
 *
 * A code fence is the exception that proves it: ``` is not wired, because
 * MDXEditor's transformer builds its own code node rather than the dialect's.
 */
const COMMANDS: SlashCommand[] = [
	{
		id: "code",
		label: "Code block",
		group: "Technical",
		keywords: ["code", "snippet", "fence"],
		run: editor => replace(editor, () => $createCodeBlockNode("")),
	},
	{
		id: "diff",
		label: "Diff",
		group: "Technical",
		keywords: ["diff", "patch", "change"],
		run: editor => replace(editor, () => $createCodeBlockNode(DIFF_LANGUAGE)),
	},
	{
		id: "mermaid",
		label: "Diagram",
		group: "Technical",
		keywords: ["mermaid", "diagram", "flowchart", "graph"],
		run: editor => replace(editor, () => $createCodeBlockNode(MERMAID_LANGUAGE)),
	},
	{
		id: "math",
		label: "Formula",
		group: "Technical",
		keywords: ["math", "latex", "katex", "equation"],
		run: editor => replace(editor, () => $createMathNode(false)),
	},
	{
		id: "image",
		label: "Image",
		group: "Technical",
		keywords: ["image", "picture", "figure", "screenshot"],
		run: editor => {
			let src = askForUrl("Image URL", { protocols: IMAGE_PROTOCOLS, relative: false });
			if (!src) return;
			editor.update(() => {
				$insertNodes([$createImageNode(src, "")]);
			});
		},
	},
	{
		id: "callout",
		label: "Callout",
		group: "Layout",
		keywords: ["note", "warning", "aside", "admonition"],
		run: insertCallout,
	},
	{
		id: "table",
		label: "Table",
		group: "Layout",
		keywords: ["table", "grid", "row", "column", "spreadsheet"],
		run: editor =>
			editor.update(() => {
				/*
				 * Row headers only.
				 *
				 * `includeHeaders: true` would mark the first cell of every row
				 * as a header too, which renders as a bold shaded column — and
				 * GFM has no way to write one, so the table would claim
				 * something on screen that the saved source does not say.
				 */
				$insertNodes([$createTableNodeWithDimensions(3, 3, { rows: true, columns: false })]);
			}),
	},
	{
		id: "tabs",
		label: "Tabs",
		group: "Layout",
		keywords: ["tab", "switch", "panel"],
		run: editor =>
			editor.update(() => {
				let tabs = $createTabsNode();
				tabs.setId(ulid());
				for (let label of ["One", "Two"]) {
					let tab = $createTabNode();
					tab.setId(ulid());
					tab.setLabel(label);
					tab.append($createParagraphNode().append($createTextNode("")));
					tabs.append(tab);
				}
				$insertNodes([tabs]);
			}),
	},
];

function match(command: SlashCommand, query: string): boolean {
	if (!query) return true;
	let needle = query.toLowerCase();
	return command.label.toLowerCase().includes(needle)
		|| command.keywords.some(word => word.includes(needle));
}

/**
 * What the caret is asking to insert, if anything.
 *
 * The slash has to start a word — beginning the block, or following a space.
 * A plan is full of paths, URLs and dates, and a rule that only looked for the
 * last slash in the line would put a menu over `src/index.ts`, `https://x.com`
 * and `24/7`. Only text behind the caret counts, so editing earlier in a line
 * that happens to contain a slash stays quiet too.
 *
 * Returns the query typed after the slash, or undefined for no trigger. An
 * empty string is a bare `/`, which opens the full list.
 */
export function trigger(text: string, offset: number): string | undefined {
	let before = text.slice(0, offset);
	let slash = before.lastIndexOf("/");
	if (slash < 0) return undefined;

	let preceding = slash > 0 ? before[slash - 1] : undefined;
	if (preceding !== undefined && !/\s/.test(preceding)) return undefined;

	let query = before.slice(slash + 1);
	// A space ends the trigger: the user moved on and is writing prose.
	if (/\s/.test(query)) return undefined;

	return query;
}

export type Decision = "open" | "close" | "ignore";

/**
 * Whether an editor update should show, hide or be ignored by the menu.
 *
 * Opening is caused, not derived. Lexical commits an update for every change
 * including a bare caret move, and an agent turn writing `/workspace/project`
 * lands text and recovers the local selection into it — so a menu that simply
 * asked "does the caret sit after a slash?" would open over content nobody
 * typed. Only a keystroke arms it.
 *
 * Closing stays unconditional: a peer deleting the slash this menu is attached
 * to should dismiss it, whoever caused the change.
 */
export function decide(
	{ typed, open, armed, remote, composing }: {
		/** Query behind the caret, from `trigger`. */
		typed: string | undefined;
		open: boolean;
		/** The local user pressed `/`. */
		armed: boolean;
		/** Applied from collaboration or history rather than this client. */
		remote: boolean;
		composing: boolean;
	},
): Decision {
	// Intermediate IME text is not a decision the author has made yet.
	if (composing) return "ignore";
	if (typed === undefined) return "close";
	if (open) return "open";
	if (remote || !armed) return "ignore";
	return "open";
}

export type SlashMenuProps = {
	disabled?: boolean;
};

export function SlashMenu({ disabled }: SlashMenuProps) {
	let [editor] = useLexicalComposerContext();
	let [query, setQuery] = useState<string>();
	let [anchor, setAnchor] = useState<DOMRectLike>();
	let [position, setPosition] = useState<SurfacePlacement>();
	let [index, setIndex] = useState(0);
	let surface = useRef<HTMLDivElement>(null);
	let open = query !== undefined && !disabled;

	let matches = useMemo(() => COMMANDS.filter(item => match(item, query ?? "")), [query]);
	// Groups now place dividers while options remain direct listbox children.
	let grouped = useMemo(() => {
		let out = new Map<string, SlashCommand[]>();
		for (let command of matches) {
			out.set(command.group, [...(out.get(command.group) ?? []), command]);
		}
		return [...out];
	}, [matches]);

	/**
	 * Set when the local user presses `/`.
	 *
	 * A ref rather than state: it gates the very update that follows the
	 * keystroke, which is committed long before a re-render would land.
	 */
	let armed = useRef(false);
	let currentQuery = useRef<string | undefined>(undefined);

	/** Read inside the update listener, which must not re-register per keystroke. */
	let showing = useRef(false);
	showing.current = open;

	let close = useCallback(() => {
		// Dismissing has to disarm, or the next update would re-derive the same
		// trigger and reopen what the user just closed.
		armed.current = false;
		currentQuery.current = undefined;
		setQuery(undefined);
		setAnchor(undefined);
		setPosition(undefined);
		setIndex(0);
	}, []);

	/**
	 * Remove the typed `/query` before acting on it.
	 *
	 * Only that span: anything the user had already written after the caret
	 * belongs to them, and truncating the line to the slash would eat it.
	 */
	let consume = useCallback(() => {
		editor.update(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return;

			let node = selection.anchor.getNode();
			if (!$isTextNode(node)) return;

			let offset = selection.anchor.offset;
			let text = node.getTextContent();
			let typed = trigger(text, offset);
			if (typed === undefined) return;

			let start = offset - typed.length - 1;
			node.setTextContent(text.slice(0, start) + text.slice(offset));
			node.select(start, start);
		});
	}, [editor]);

	let choose = useCallback((command: SlashCommand) => {
		consume();
		close();
		command.run(editor);
	}, [consume, close, editor]);

	// Arming is what separates a slash the author typed from one that arrived
	// with someone else's edit. Registered whether or not the menu is showing,
	// because it is the thing that decides whether it should.
	useEffect(() => {
		return editor.registerCommand(
			KEY_DOWN_COMMAND,
			(event: KeyboardEvent) => {
				if (event.key === "/") armed.current = true;
				return false;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);

	// Track what follows the `/` so the list can filter as the user types.
	useEffect(() => {
		// Clears any query left behind by the lock, which would otherwise spring
		// the menu open the moment an agent turn ends.
		if (disabled) {
			close();
			return;
		}
		return editor.registerUpdateListener(({ tags }) => {
			editor.getEditorState().read(() => {
				let selection = $getSelection();
				if (!$isRangeSelection(selection) || !selection.isCollapsed()) return close();

				let typed = trigger(
					selection.anchor.getNode().getTextContent(),
					selection.anchor.offset,
				);

				let decision = decide({
					typed,
					open: showing.current,
					armed: armed.current,
					remote: tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG),
					composing: editor.isComposing(),
				});
				if (decision === "ignore") return;
				if (decision === "close") return close();

				let rect = nativeSelectionRect();
				if (!rect) return close();

				if (typed !== currentQuery.current) setIndex(0);
				currentQuery.current = typed;
				setQuery(typed);
				setAnchor(rect);
			});
		});
	}, [editor, close, disabled]);

	let place = useCallback(() => {
		let element = surface.current;
		if (!element || !anchor) return;
		let liveAnchor = nativeSelectionRect();
		if (!liveAnchor) {
			setPosition(undefined);
			return;
		}
		let viewport = editorSurfaceViewport(editor);
		element.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
		let next = placeSurface(
			liveAnchor,
			{ width: element.offsetWidth, height: element.scrollHeight },
			viewport,
		);
		setPosition(current =>
			current?.left === next.left && current.top === next.top
				&& current.maxHeight === next.maxHeight
				? current
				: next
		);
	}, [anchor]);
	useLayoutEffect(() => {
		if (open) place();
	}, [open, grouped, place]);

	useEffect(() => {
		if (!open) return;
		return listenToEditorGeometry(editor, place);
	}, [editor, open, place]);

	let selected = useRef(matches[0]);
	selected.current = matches[index];

	useEffect(() => {
		if (!open) return;
		return editor.registerCommand(
			KEY_DOWN_COMMAND,
			(event: KeyboardEvent) => {
				if (event.key === "Escape") {
					close();
				} else if (event.key === "ArrowDown") {
					setIndex(value => (value + 1) % Math.max(matches.length, 1));
				} else if (event.key === "ArrowUp") {
					setIndex(value => (value - 1 + matches.length) % Math.max(matches.length, 1));
				} else if (event.key === "Enter" || event.key === "Tab") {
					let command = selected.current;
					if (!command) return false;
					choose(command);
				} else {
					return false;
				}
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor, open, matches.length, close, choose]);

	if (!open || !anchor || matches.length === 0) return null;

	let flat = matches;

	return (
		<div
			ref={surface}
			role="listbox"
			aria-label="Insert block"
			data-focus-boundary=""
			contentEditable={false}
			className={`${SHELL} max-h-72 w-56 overflow-y-auto`}
			style={position
				? { top: position.top, left: position.left, maxHeight: position.maxHeight }
				: { top: anchor.bottom + 8, left: anchor.left, visibility: "hidden" }}
			onMouseDown={event => event.preventDefault()}
		>
			{grouped.map(([group, commands], place) => (
				<Fragment key={group}>
					{place > 0 && <div aria-hidden="true" className={DIVIDER} />}
					{commands.map(command => {
						let position = flat.indexOf(command);
						return (
							<button
								key={command.id}
								type="button"
								role="option"
								aria-selected={position === index}
								data-press="wide"
								onMouseEnter={() => setIndex(position)}
								onClick={() => choose(command)}
								className={`${ROW} ${
									position === index
										? "bg-selected text-text-primary"
										: "text-text-tertiary"
								}`}
							>
								{command.label}
							</button>
						);
					})}
				</Fragment>
			))}
		</div>
	);
}
