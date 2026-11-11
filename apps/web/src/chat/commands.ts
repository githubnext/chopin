import { commandGroupLabel } from "@chopin/protocol/commands";

import { referencePickerKeyAction } from "./reference-picker";

import type { Chat } from "@chopin/protocol";
import type { ReferencePickerKeyAction } from "./reference-picker";

/**
 * One row of what `/` offers: Chat's own command, or one the document's agent reports. The list is
 * adapted from assistant-ui's slash commands element (`ComposerCommand`: a name and a line of
 * description), grouped by where each comes from.
 */
export type ChatCommand = {
	/** Chat runs its own; the agent's are sent to it, chosen as a chip that opens the message. */
	source: "chat" | "agent";
	/** Unique in the list, though an agent may report a name twice. */
	id: string;
	/** What follows the slash. */
	name: string;
	/** The `kind` the agent reported, for a command of its own. */
	commandKind?: string;
	/** The heading it is listed under. */
	group: string;
	/** One line, as the agent wrote it or as Chat words it. */
	description?: string;
	keywords: readonly string[];
};

const BUILT_IN = "Built in";

/**
 * What `/` offers in Chat besides the agent's commands.
 *
 * Only commands that mean something here. Research is placed in the
 * document, so Chat opens the document's research composer with the brief
 * rather than posting the command as a message.
 */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
	{
		source: "chat",
		id: "research",
		name: "research",
		group: BUILT_IN,
		description: "Search the web for this document",
		keywords: ["research", "web search"],
	},
];

/**
 * Chat's own commands, then the agent's, grouped by their kind in the order each kind first
 * appears and listed in the order reported. A name the agent reported twice is listed twice, and
 * one called like one of Chat's own is listed too, under its own heading.
 */
export function commandList(
	own: readonly ChatCommand[],
	reported: readonly Chat.CommandOption[] | undefined,
): ChatCommand[] {
	let groups: string[] = [];
	let byGroup = new Map<string, ChatCommand[]>();
	for (let [index, option] of (reported ?? []).entries()) {
		let group = commandGroupLabel(option.kind);
		if (!byGroup.has(group)) {
			groups.push(group);
			byGroup.set(group, []);
		}
		byGroup.get(group)!.push({
			source: "agent",
			id: `agent:${index}`,
			name: option.name,
			commandKind: option.kind,
			group,
			...(option.description !== undefined ? { description: option.description } : {}),
			keywords: [option.name, option.name.replace(/^[^:]*:/, "")],
		});
	}
	return [...own, ...groups.flatMap(group => byGroup.get(group)!)];
}

export type CommandTrigger = { query: string; end: number };

/** A `/query` that is the whole draft so far, with the caret at its end. */
export function commandTrigger(
	text: string,
	selectionStart: number,
	selectionEnd = selectionStart,
): CommandTrigger | undefined {
	if (selectionStart !== selectionEnd) return undefined;
	let match = /^\/([\w:.-]*)$/.exec(text.slice(0, selectionStart));
	if (!match || /\S/.test(text.slice(selectionStart))) return undefined;
	return { query: match[1]!, end: selectionStart };
}

export function commandTriggerKey(trigger: CommandTrigger): string {
	return `command:${trigger.end}:${trigger.query}`;
}

export function filterCommands(
	commands: readonly ChatCommand[],
	query: string,
): ChatCommand[] {
	let prefix = query.toLowerCase();
	return commands.filter(command =>
		command.keywords.some(keyword => keyword.toLowerCase().startsWith(prefix))
	);
}

const RESEARCH_COMMAND = /^\s*(?:@chopin\s+)?\/research(?=\s|$)\s*/i;

/**
 * The command a draft starts with, which must never be posted as a message.
 * An `@chopin` in front is the same command, not a question for the Planner.
 */
export function draftCommand(text: string): ChatCommand["id"] | undefined {
	return RESEARCH_COMMAND.test(text) ? "research" : undefined;
}

/** What follows the command: the research brief. */
export function commandBrief(text: string): string {
	return text.replace(RESEARCH_COMMAND, "").trim();
}

export function commandText(command: ChatCommand): string {
	return `/${command.name} `;
}

/** Tab selects, as it does in the document's `/` menu. */
export function commandKeyAction(
	event: {
		key: string;
		keyCode?: number;
		isComposing?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
		ctrlKey?: boolean;
		metaKey?: boolean;
	},
	selectable: boolean,
): ReferencePickerKeyAction | undefined {
	if (
		event.key === "Tab"
		&& selectable
		&& !event.isComposing
		&& event.keyCode !== 229
		&& !event.shiftKey
		&& !event.altKey
		&& !event.ctrlKey
		&& !event.metaKey
	) return "select";
	return referencePickerKeyAction(event, selectable);
}
