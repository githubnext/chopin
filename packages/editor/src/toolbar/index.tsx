/**
 * Editor chrome.
 *
 * Mounted as composer children so both surfaces sit inside the Lexical context
 * and can read the live selection.
 */

import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection } from "lexical";

import { $describe } from "../passage";
import { widgets$ } from "../widgets-plugin";
import { SelectionBubble } from "./bubble";
import { SlashMenu } from "./slash";

/**
 * Reads what it needs from the realm so the surfaces below it stay ordinary
 * prop-driven components. `readOnly$` is the editor's own account of whether
 * it can be edited, and the chrome has no business holding a second opinion.
 */
export function Toolbar() {
	let disabled = useCellValue(readOnly$);
	let options = useCellValue(widgets$);
	let [editor] = useLexicalComposerContext();

	let threads = options.threads;

	// Commenting is offered only when there is somewhere for the comment to
	// go, so the button cannot appear on a surface with no sidecar.
	let comment = threads
		? () => {
			// Capture native geometry before the draft takes focus.
			let selection = window.getSelection();
			let range = selection?.rangeCount
				? selection.getRangeAt(0).getBoundingClientRect()
				: undefined;
			editor.getEditorState().read(() => {
				let marked = $describe($getSelection());
				if (marked) {
					threads.draft({
						...marked,
						...(range
							? {
								placement: {
									top: range.top,
									right: range.right,
									bottom: range.bottom,
									left: range.left,
									width: range.width,
									height: range.height,
								},
							}
							: {}),
					});
				}
			});
		}
		: undefined;

	return (
		<>
			<SelectionBubble disabled={disabled} onComment={comment} />
			<SlashMenu disabled={disabled} research={options.research} />
		</>
	);
}

export { SelectionBubble } from "./bubble";
export { SlashMenu } from "./slash";
export type { SlashCommand } from "./slash";
