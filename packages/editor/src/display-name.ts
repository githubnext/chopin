import { personName } from "./people";

/** How a person is named beside their face, in comments and in Chat. */
export function displayName(handle: string): string {
	let name = personName(handle);
	return name ? name[0]!.toUpperCase() + name.slice(1) : name;
}
