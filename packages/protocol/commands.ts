/**
 * The commands a document's agent offers, and how a turn is told to run one. The server checks a
 * request against what the agent reports now and builds the turn from it; the browser groups and
 * names them for `/`. Both read the same kinds, so a command never means one thing in the list and
 * another when it runs.
 */

import type { Chat } from "./chat";

/** The kinds of command a harness reports that Chopin knows by name. */
export const COMMAND_KINDS = {
	skill: "skill",
	prompt: "prompt",
} as const;

/**
 * The heading a kind of command is listed under. A kind Chopin does not know is its own group, named
 * as the agent wrote it.
 */
export function commandGroupLabel(kind: string): string {
	if (kind === COMMAND_KINDS.skill) return "Skills";
	if (kind === COMMAND_KINDS.prompt) return "Prompt templates";
	return kind;
}

/**
 * The command a request names, exactly as the agent reported it: the first entry with this name
 * and kind. A catalog may list a name twice, as another kind or again, and each is its own entry.
 */
export function offeredCommand(
	commands: readonly Chat.CommandOption[] | undefined,
	name: string,
	kind: string,
): Chat.CommandOption | undefined {
	return commands?.find(command => command.name === name && command.kind === kind);
}

/**
 * What the agent's turn is given for a command and the words after it: Atomic's own `/name args`
 * invocation, whatever its kind.
 */
export function commandPrompt(
	command: Pick<Chat.CommandOption, "name" | "kind">,
	args: string,
): string {
	return args ? `/${command.name} ${args}` : `/${command.name}`;
}
