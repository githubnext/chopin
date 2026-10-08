import { MENU_ROW, MENU_ROW_OFF, MENU_ROW_ON, MENU_SURFACE } from "@chopin/editor";

import { referenceOptionId } from "./reference-picker";

import type { ChatCommand } from "./commands";

/** The document's `/` menu, anchored above the Chat composer. */
export function CommandPicker(
	{
		active,
		id,
		onActive,
		onSelect,
		options,
	}: {
		active: number;
		id: string;
		onActive: (index: number) => void;
		onSelect: (command: ChatCommand) => void;
		options: readonly ChatCommand[];
	},
) {
	return (
		<div
			className={`absolute bottom-full left-2.5 z-30 mb-1 w-56 max-w-[calc(100%-1.25rem)] ${MENU_SURFACE}`}
			data-chat-command-picker=""
			data-focus-boundary=""
		>
			<div aria-label="Commands" id={id} role="listbox">
				{options.map((option, index) => (
					<button
						aria-selected={index === active}
						className={`${MENU_ROW} ${index === active ? MENU_ROW_ON : MENU_ROW_OFF}`}
						data-press="wide"
						id={referenceOptionId(id, index)}
						key={option.id}
						onClick={() => onSelect(option)}
						onMouseDown={event => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
						role="option"
						tabIndex={-1}
						type="button"
					>
						{option.label}
					</button>
				))}
			</div>
		</div>
	);
}
