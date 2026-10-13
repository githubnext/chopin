import type { Session } from "@chopin/protocol";

/**
 * Derive people from a connection roster.
 *
 * A GitHub login is compared case-insensitively. A demo actor is a separate
 * identity even when it shares the presenter's account, so it is keyed apart and
 * never merged with a login; only a second tab of the same actor collapses.
 */
export function peopleHere(members: readonly Session.Member[]): string[] {
	let seen = new Set<string>();
	let people: string[] = [];
	for (let member of members) {
		let identity = member.actor ? `actor:${member.handle}` : `login:${member.handle.toLowerCase()}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		people.push(member.handle);
	}
	return people;
}
