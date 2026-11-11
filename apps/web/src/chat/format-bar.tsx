/**
 * The message box's formatting toolbar: bold, italic and strikethrough, a link, a numbered and a
 * bulleted list, code and a code block. Each formats the draft through `onFormat`, which draws it
 * as it will read, and each is shown pressed while the caret is in its format. A press never takes
 * the draft's focus or selection, which is what it formats.
 */

import {
	BoldIcon,
	BulletedListIcon,
	CodeBlockIcon,
	CodeIcon,
	ItalicIcon,
	LinkIcon,
	NumberedListIcon,
	StrikethroughIcon,
} from "@chopin/icons";

import { currentShortcutPlatform, shortcutLabel } from "../shortcuts";
import { FORMAT_SHORTCUTS } from "./rich/shortcuts";

import type { ReactNode } from "react";
import type { Format } from "./format";

/** The chord of each mark, as its tooltip shows it. */
const CHORDS = new Map(FORMAT_SHORTCUTS.map(([id, format]) => [format, id]));

const GROUPS: { format: Format; label: string; icon: ReactNode }[][] = [
	[
		{ format: "bold", label: "Bold", icon: <BoldIcon size={16} /> },
		{ format: "italic", label: "Italic", icon: <ItalicIcon size={16} /> },
		{ format: "strike", label: "Strikethrough", icon: <StrikethroughIcon size={16} /> },
	],
	[{ format: "link", label: "Link", icon: <LinkIcon size={16} /> }],
	[
		{ format: "numbered", label: "Numbered list", icon: <NumberedListIcon size={16} /> },
		{ format: "bulleted", label: "Bulleted list", icon: <BulletedListIcon size={16} /> },
	],
	[
		{ format: "code", label: "Code", icon: <CodeIcon size={16} /> },
		{ format: "block", label: "Code block", icon: <CodeBlockIcon size={16} /> },
	],
];

export function FormatBar(
	{ active, disabled, onFormat }: {
		/** The marks at the caret, shown pressed. */
		active: ReadonlySet<Format>;
		disabled: boolean;
		onFormat: (format: Format) => void;
	},
) {
	return (
		<div aria-label="Formatting" className="composer-format" role="toolbar">
			{GROUPS.map((group, position) => (
				<div className="composer-format-group" key={group[0]!.format} role="presentation">
					{position > 0 && <span aria-hidden="true" className="composer-format-divider" />}
					{group.map(({ format, label, icon }) => (
						<button
							aria-label={label}
							aria-pressed={active.has(format)}
							className="btn btn-icon btn-ghost"
							data-tooltip={label}
							data-tooltip-shortcut={shortcutLabel(CHORDS.get(format)!, currentShortcutPlatform())}
							data-tooltip-verbatim=""
							disabled={disabled}
							key={format}
							onClick={() => onFormat(format)}
							// The draft keeps its focus and selection, which the mark is applied to.
							onMouseDown={event =>
								event.preventDefault()}
							title={label}
							type="button"
						>
							{icon}
						</button>
					))}
				</div>
			))}
		</div>
	);
}
