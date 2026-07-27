/**
 * Remote cursor identity.
 *
 * Colour is derived from the login rather than assigned on arrival, so everyone
 * sees the same person in the same colour. Order-based assignment gives each
 * client a different mapping, which makes cursors impossible to learn.
 */

const PALETTE = [
	"#e06c75", // red
	"#c678dd", // purple
	"#56b6c2", // teal
	"#d19a66", // orange
	"#7c3aed", // violet
	"#98c379", // green
	"#e5c07b", // yellow
	"#f472b6", // pink
] as const;

/** FNV-1a: small, stable, and good enough to spread logins across a palette. */
function hash(value: string): number {
	let out = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		out ^= value.charCodeAt(i);
		out = Math.imul(out, 0x01000193);
	}
	return out >>> 0;
}

export function color(login: string): string {
	return PALETTE[hash(login) % PALETTE.length]!;
}

export type Cursor = { name: string; color: string };

export function cursor(login: string): Cursor {
	return { name: login, color: color(login) };
}
