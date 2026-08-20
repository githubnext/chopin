import type { Session } from "@chopin/protocol";

/** Derive people from a connection roster using GitHub's case-insensitive login identity. */
export function peopleHere(members: readonly Session.Member[]): Session.Member[] {
	let seen = new Set<string>();
	return members.filter(member => {
		let identity = member.handle.toLowerCase();
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}
