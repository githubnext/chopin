/**
 * Editor chrome.
 *
 * Mounted as composer children so both surfaces sit inside the Lexical context
 * and can read the live selection.
 */

import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";

import { SelectionBubble } from "./bubble";
import { SlashMenu } from "./slash";

export type ToolbarProps = Record<string, never>;

/**
 * Reads what it needs from the realm so the surfaces below it stay ordinary
 * prop-driven components. `readOnly$` is the editor's own account of whether
 * it can be edited, and the chrome has no business holding a second opinion.
 */
export function Toolbar() {
	let disabled = useCellValue(readOnly$);

	return (
		<>
			<SelectionBubble disabled={disabled} />
			<SlashMenu disabled={disabled} />
		</>
	);
}

export { SelectionBubble } from "./bubble";
export { SlashMenu } from "./slash";
export type { SlashCommand } from "./slash";
