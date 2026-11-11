import { COMMAND_KINDS } from "@chopin/protocol/commands";
import { GlobeIcon, PlayIcon, SparklesIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { useEffect } from "react";
import { ComposerCommandItem } from "@/components/assistant-ui/elements/composer";
import { ComposerPopover } from "./assistant-ui/composer-popover";
import { referenceOptionId } from "./reference-picker";

import type { ChatCommand } from "./commands";

/** The row's icon is the kind the command is: Chat's own, a skill, a prompt template, a workflow. */
function icon(command: ChatCommand) {
	if (command.source === "chat") return GlobeIcon;
	switch (command.commandKind) {
		case COMMAND_KINDS.skill:
			return SparklesIcon;
		case COMMAND_KINDS.prompt:
			return TerminalIcon;
		case COMMAND_KINDS.workflow:
			return PlayIcon;
		default:
			return WrenchIcon;
	}
}

/**
 * The `/` menu over the Chat composer, assistant-ui's Slash commands: the icon of what each is,
 * `/name`, one line of its description, and a `↵` on the row that Enter runs. Chat's own command
 * comes first, then the ones the document's agent reports, in the order it reported them.
 */
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
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id]);

	return (
		<ComposerPopover id={id} kind="commands" label="Commands">
			{options.map((command, index) => (
				<ComposerCommandItem
					active={index === active}
					aria-selected={index === active}
					command={{
						name: command.name,
						description: command.description ?? "",
						icon: icon(command),
					}}
					id={referenceOptionId(id, index)}
					key={command.id}
					onClick={() => onSelect(command)}
					onMouseDown={event => event.preventDefault()}
					onMouseEnter={() => onActive(index)}
					role="option"
					tabIndex={-1}
				/>
			))}
		</ComposerPopover>
	);
}
