import { ComposerMenu, ComposerMenuItem } from "./assistant-ui/composer-model";
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
		<ComposerMenu variant="commands">
			<div aria-label="Commands" id={id} role="listbox">
				{options.map((option, index) => (
					<ComposerMenuItem
						active={index === active}
						data-press="wide"
						id={referenceOptionId(id, index)}
						key={option.id}
						onClick={() => onSelect(option)}
						onMouseDown={event => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
						selected={index === active}
					>
						{option.label}
					</ComposerMenuItem>
				))}
			</div>
		</ComposerMenu>
	);
}
