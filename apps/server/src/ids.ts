/** Short opaque identifiers for things that only need to be distinct in memory. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function uid(length = 12): string {
	let bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (let byte of bytes) out += ALPHABET[byte % ALPHABET.length];
	return out;
}
