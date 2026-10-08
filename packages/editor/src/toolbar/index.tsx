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
import { useEffect, useState } from "react";

import { $describe } from "../passage";
import { widgets$ } from "../widgets-plugin";
import { SelectionBubble } from "./bubble";
import { LinkSurface } from "./link";
import { ResearchComposerSurface } from "./research";
import { ResearchLaunchRegistration } from "./research-launch";
import { SlashMenu } from "./slash";
import { registerTaskRule } from "./task-rule";

const RESEARCH_ACTIONS = new Set(["research"]);

/**
 * Reads what it needs from the realm so the surfaces below it stay ordinary
 * prop-driven components. `readOnly$` is the editor's own account of whether
 * it can be edited, and the chrome has no business holding a second opinion.
 */
export function Toolbar() {
	let disabled = useCellValue(readOnly$);
	let options = useCellValue(widgets$);
	let [editor] = useLexicalComposerContext();
	// The link editor sits where the bubble would, so only one shows.
	let [linking, setLinking] = useState(false);

	useEffect(() => (disabled ? undefined : registerTaskRule(editor)), [editor, disabled]);

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
			<SelectionBubble disabled={disabled} hidden={linking} onComment={comment} />
			<LinkSurface binding={options.binding} disabled={disabled} onEditing={setLinking} />
			<SlashMenu
				actions={options.research && options.researchDrafts ? RESEARCH_ACTIONS : undefined}
				disabled={disabled}
			/>
			{options.research && options.researchDrafts && (
				<ResearchComposerSurface
					binding={options.binding}
					disabled={disabled}
					drafts={options.researchDrafts}
					research={options.research}
				/>
			)}
			{options.research && options.researchDrafts && options.researchLauncher && (
				<ResearchLaunchRegistration
					binding={options.binding}
					canEdit={options.canEdit}
					connected={options.connected}
					disabled={disabled}
					drafts={options.researchDrafts}
					launcher={options.researchLauncher}
				/>
			)}
		</>
	);
}

export { SelectionBubble } from "./bubble";
export { SlashMenu } from "./slash";
export type { SlashCommand } from "./slash";
