import { CodeIcon, GlobeSearchIcon, PlayIcon, SparkleIcon, TerminalIcon } from "@chopin/icons";
import { COMMAND_KINDS } from "@chopin/protocol/commands";
import { useEffect, useId } from "react";

import { ComposerCommandItem, ComposerMenuGroup } from "./assistant-ui/composer-commands";
import { ComposerMenu } from "./assistant-ui/composer-model";
import { referenceOptionId } from "./reference-picker";

import type { ChatCommand } from "./commands";

function lead(command: ChatCommand) {
	if (command.source === "chat") return <GlobeSearchIcon size={16} />;
	switch (command.commandKind) {
		case COMMAND_KINDS.skill:
			return <SparkleIcon size={16} />;
		case COMMAND_KINDS.prompt:
			return <TerminalIcon size={16} />;
		case COMMAND_KINDS.workflow:
			return <PlayIcon size={16} />;
		default:
			return <CodeIcon size={16} />;
	}
}

/**
 * The `/` menu, anchored above the Chat composer: Chat's own commands and the agent's, each under
 * the heading of where it comes from, one line each with its description.
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
	let groupId = useId();
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id]);

	// Consecutive rows of one group share its heading.
	let groups: Array<{ group: string; rows: Array<{ command: ChatCommand; index: number }> }> = [];
	for (let [index, command] of options.entries()) {
		let last = groups.at(-1);
		if (last?.group === command.group) last.rows.push({ command, index });
		else groups.push({ group: command.group, rows: [{ command, index }] });
	}

	return (
		<ComposerMenu variant="commands">
			<div aria-label="Commands" id={id} role="listbox">
				{groups.map((section, position) => (
					<ComposerMenuGroup
						id={`${groupId}-${position}`}
						key={`${section.group}:${position}`}
						label={section.group}
					>
						{section.rows.map(({ command, index }) => (
							<ComposerCommandItem
								active={index === active}
								description={command.description}
								id={referenceOptionId(id, index)}
								key={command.id}
								lead={lead(command)}
								name={command.name}
								onClick={() => onSelect(command)}
								onMouseDown={event => event.preventDefault()}
								onMouseEnter={() => onActive(index)}
							/>
						))}
					</ComposerMenuGroup>
				))}
			</div>
		</ComposerMenu>
	);
}
