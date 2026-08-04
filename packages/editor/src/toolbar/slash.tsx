/**
 * Block insertion, driven by typing `/`.
 *
 * Everything inserts locally and immediately, including the components that
 * carry a durable id: a ULID has enough entropy that two clients cannot mint
 * the same one, so buying uniqueness with a server round trip would only make
 * the block appear later than the keystroke that asked for it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $setBlocksType } from "@lexical/selection";
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

import type { ElementNode, LexicalEditor } from "lexical";

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
		run: editor =>
			replace(editor, () => {
				let callout = $createCalloutNode();
				callout.setId(ulid());
				return callout;
			}),
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
	let [position, setPosition] = useState<{ top: number; left: number }>();
	let [index, setIndex] = useState(0);
	let open = query !== undefined && !disabled;

	let matches = useMemo(() => COMMANDS.filter(item => match(item, query ?? "")), [query]);
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

	/** Read inside the update listener, which must not re-register per keystroke. */
	let showing = useRef(false);
	showing.current = open;

	let close = useCallback(() => {
		// Dismissing has to disarm, or the next update would re-derive the same
		// trigger and reopen what the user just closed.
		armed.current = false;
		setQuery(undefined);
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

				let native = window.getSelection();
				if (!native || native.rangeCount === 0) return close();
				let rect = native.getRangeAt(0).getBoundingClientRect();

				setQuery(typed);
				setPosition({ top: rect.bottom + 4, left: rect.left });
			});
		});
	}, [editor, close, disabled]);

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

	if (!open || !position || matches.length === 0) return null;

	let flat = matches;

	return (
		<div
			role="listbox"
			aria-label="Insert block"
			contentEditable={false}
			className="fixed z-50 max-h-72 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
			style={{ top: position.top, left: position.left }}
			onMouseDown={event => event.preventDefault()}
		>
			{grouped.map(([group, commands]) => (
				<div key={group}>
					<div className="px-2 py-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
						{group}
					</div>
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
								className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition ${
									position === index
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted"
								}`}
							>
								<span>{command.label}</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
