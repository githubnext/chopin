/**
 * The short line a build's progress shows for what its coding agent is doing.
 *
 * Agents title a shell tool call with the command itself, which is unreadable as progress and can
 * carry tokens or private paths, so a command reads as "Running a command" and anything that looks
 * like a credential is replaced. The connector passes the ACP tool kind; Chopin applies the same
 * rule without it to every heartbeat, so an older connector's raw commands stay out of view.
 */

export const RUNNING_A_COMMAND = "Running a command";
const WORKING = "Working";
const LIMIT = 80;

/** Shell syntax, an option flag, or an environment assignment. */
const SHELL = /[;|&$`<>\\{}]|(?:^|\s)--?[A-Za-z]|(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/;
/** Well-known token prefixes, a bearer credential, or a long unbroken key-like run. */
const SECRET =
	/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abpr]-|sk-|AKIA)[A-Za-z0-9_-]{8,}|\bbearer\s+\S{8,}|[A-Za-z0-9+_=-]{32,}/i;

export function activityText(title: string, kind?: string): string | undefined {
	let text = title.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	let command = kind === "execute";
	if (SECRET.test(text)) return command ? RUNNING_A_COMMAND : WORKING;
	// A shell tool's title is prose only when it reads as a sentence.
	if (SHELL.test(text) || command && !/^\p{Lu}/u.test(text)) return RUNNING_A_COMMAND;
	if (text.length <= LIMIT) return text;
	let cut = text.slice(0, LIMIT - 1);
	let space = cut.lastIndexOf(" ");
	return `${(space > LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
