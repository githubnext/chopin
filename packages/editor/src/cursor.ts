/**
 * Remote cursor identity.
 *
 * Colour is derived from the login rather than assigned on arrival, so everyone
 * sees the same person in the same colour. Order-based assignment gives each
 * client a different mapping, which makes cursors impossible to learn.
 */

const PALETTE = [
	"#BF5257", // coral
	"#B25D25", // amber
	"#977103", // gold
	"#54803A", // fern
	"#358264", // jade
	"#4375C9", // cobalt
	"#7E65BB", // violet
	"#A45B9F", // fuchsia
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
