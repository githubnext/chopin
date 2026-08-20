import type { Session } from "@chopin/protocol";

/** Derive people from a connection roster using GitHub's case-insensitive login identity. */
export function peopleHere(members: readonly Session.Member[]): string[] {
	let seen = new Set<string>();
	let people: string[] = [];
	for (let member of members) {
		let identity = member.handle.toLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		people.push(member.handle);
	}
	return people;
}
