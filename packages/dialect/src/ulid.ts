/**
 * Component identity.
 *
 * ULIDs rather than UUIDs because they sort by creation time, which makes a
 * plan's raw source readable in the order it was written, and because they are
 * Crockford base32 — no hyphens, no ambiguous characters, and legible when they
 * appear in an MDX attribute a person has to read.
 *
 * Minted on whichever side creates the component. Eighty bits of randomness per
 * millisecond is enough that two editors inserting at the same instant will not
 * collide, so this needs no coordination.
 */

/** Crockford base32: no I, L, O or U, so nothing reads as a digit by mistake. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** Matches what the validator accepts. */
export const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now = Date.now()): string {
	let time = "";
	let remaining = now;
	for (let i = 0; i < TIME_CHARS; i++) {
		time = ALPHABET[remaining % 32] + time;
		remaining = Math.floor(remaining / 32);
	}

	let bytes = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
	let random = "";
	for (let byte of bytes) random += ALPHABET[byte % 32];

	return time + random;
}
