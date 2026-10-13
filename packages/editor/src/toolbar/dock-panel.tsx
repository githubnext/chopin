/**
 * The choices behind the phone dock's Insert and Text style buttons.
 *
 * A web page cannot replace the software keyboard, so the panel takes the keyboard's place
 * instead: the dock lets the keyboard go and shows the panel at its height, and a choice gives
 * the caret back to the editor, which brings the keyboard back up.
 */

import { CheckIcon, ListIcon } from "@chopin/icons";

import { $openBlock, insertList } from "./block-target";
import { convertBlock } from "./bubble";
import { availableCommands } from "./slash";
import { nativeSelectionRect } from "./surface";

import type { ReactNode } from "react";
import type { LexicalEditor } from "lexical";
import type { Block } from "./bubble";

export type DockPanel = "insert" | "style";

/** Taller than any browser toolbar, shorter than any software keyboard. */
const KEYBOARD_MIN = 120;

/** How much of the layout viewport the keyboard covers right now, however little. */
export function covered(
	innerHeight: number,
	visual: { top: number; height: number } | undefined,
): number {
	return visual ? Math.max(0, Math.round(innerHeight - visual.top - visual.height)) : 0;
}

/** How much of the layout viewport the software keyboard covers, if it is up. */
export function keyboardCover(
	innerHeight: number,
	visual: { top: number; height: number } | undefined,
): number | undefined {
	let cover = covered(innerHeight, visual);
	return cover >= KEYBOARD_MIN ? cover : undefined;
}

/**
 * The panel's height while the keyboard moves: only the space the keyboard has uncovered, so
 * the bar above them stays where it rests however the browser reports the keyboard's travel.
 */
export function uncovered(panel: number, cover: number): number {
	return Math.min(panel, Math.max(0, panel - cover));
}

export type PanelChoice = {
	id: string;
	label: string;
	glyph: ReactNode;
	/** Set for a style: whether the caret's block already has it. */
	current?: boolean;
	run: (editor: LexicalEditor) => void;
};

/** Kinds of list belong with the other text styles, not with the blocks. */
const STYLED = new Set(["tasks"]);

/** The slash menu's blocks, and the actions (Research, Investigate) the host offers. */
export function insertChoices(actions: ReadonlySet<string>): PanelChoice[] {
	return availableCommands("")
		.filter(command => !STYLED.has(command.id))
		.filter(command => command.kind === "insert" || actions.has(command.id))
		.map(command => ({
			id: command.id,
			label: command.label,
			glyph: <command.icon size={18} />,
			run: editor => {
				// One update, so one undo removes the opened line with the block.
				if (command.kind === "insert") {
					return editor.update(() => {
						$openBlock();
						command.run(editor);
					});
				}
				editor.update($openBlock, { discrete: true });
				// Nothing was typed to start it, so there is no trigger to consume.
				let anchor = nativeSelectionRect();
				if (anchor) command.run(editor, { anchor, consume: () => true });
			},
		}));
}

/** Each glyph is drawn the way the style looks, so the panel reads like a type specimen. */
const STYLES: Array<{ id: Block; label: string; glyph: ReactNode }> = [
	{ id: "paragraph", label: "Text", glyph: <span>T</span> },
	{ id: "h1", label: "Heading 1", glyph: <span className="font-semibold">H1</span> },
	{ id: "h2", label: "Heading 2", glyph: <span className="font-semibold">H2</span> },
	{ id: "h3", label: "Heading 3", glyph: <span className="font-semibold">H3</span> },
	{ id: "quote", label: "Quote", glyph: <span className="font-semibold">“</span> },
	{ id: "bullet", label: "Bulleted list", glyph: <ListIcon size={18} /> },
	{ id: "number", label: "Numbered list", glyph: <span>1.</span> },
	{ id: "task", label: "Task list", glyph: <CheckIcon size={18} /> },
];

export function styleChoices(current: Block): PanelChoice[] {
	return STYLES.map(style => ({
		...style,
		current: style.id === current,
		run: editor => {
			if (style.id === current) return;
			if (style.id === "task") {
				insertList(editor, "check");
				return;
			}
			convertBlock(editor, current, style.id);
		},
	}));
}
