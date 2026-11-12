import { personName } from "./people";

/**
 * How a person is named beside their face, in comments and in Chat: their handle exactly as
 * GitHub has it, as Slack names a person by their username, or a demo actor's roster name.
 */
export function displayName(handle: string): string {
	return personName(handle);
}
