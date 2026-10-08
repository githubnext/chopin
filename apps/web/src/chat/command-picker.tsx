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
			className="absolute bottom-full left-2.5 z-30 mb-1 w-56 max-w-[calc(100%-1.25rem)] rounded-lg bg-page p-1 ring-hairline shadow-raised"
			data-chat-command-picker=""
			data-focus-boundary=""
		>
			<div aria-label="Commands" id={id} role="listbox">
				{options.map((option, index) => (
					<button
						aria-selected={index === active}
						className={`plan-menu-row flex h-8 w-full items-center rounded-sm px-2 text-left text-sm ${
							index === active ? "bg-selected text-text-primary" : "text-text-tertiary"
						}`}
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
