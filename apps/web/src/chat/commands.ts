import { referencePickerKeyAction } from "./reference-picker";

import type { ReferencePickerKeyAction } from "./reference-picker";

export type ChatCommand = {
	id: "research";
	label: string;
	keywords: readonly string[];
};

/**
 * What `/` offers in Chat.
 *
 * Only commands that mean something here. Research is placed in the
 * document, so Chat opens the document's research composer with the brief
 * rather than posting the command as a message.
 */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
	{ id: "research", label: "Research", keywords: ["research", "web search"] },
];

export type CommandTrigger = { query: string; end: number };

/** A `/query` that is the whole draft so far, with the caret at its end. */
export function commandTrigger(
	text: string,
	selectionStart: number,
	selectionEnd = selectionStart,
): CommandTrigger | undefined {
	if (selectionStart !== selectionEnd) return undefined;
	let match = /^\/([a-z]*)$/i.exec(text.slice(0, selectionStart));
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
	return commands.filter(command => command.keywords.some(keyword => keyword.startsWith(prefix)));
}

/** The command a draft starts with, which must never be posted as a message. */
export function draftCommand(text: string): ChatCommand["id"] | undefined {
	return /^\s*\/research(?=\s|$)/i.test(text) ? "research" : undefined;
}

export function commandText(command: ChatCommand): string {
	return `/${command.id} `;
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
