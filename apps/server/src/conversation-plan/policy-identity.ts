import { createHash } from "node:crypto";
import { QUESTION_SET_VERSION } from "./question-shared";

export function stableId(
	channelId: string,
	messageId: string,
	index: number,
	kind: string,
): string {
	let digest = createHash("sha256").update(JSON.stringify([
		channelId,
		messageId,
		index,
		kind,
		QUESTION_SET_VERSION,
	])).digest("hex").slice(0, 24);
	return `classifier:${digest}`;
}

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Card option identity uses the message time and deterministic message-derived randomness. */
export function optionIdFor(
	channelId: string,
	messageId: string,
	index: number,
	at: number,
): string {
	let digest = createHash("sha256").update(JSON.stringify([
		channelId,
		messageId,
		index,
		"option",
		QUESTION_SET_VERSION,
	])).digest();
	let time = "";
	let milliseconds = Math.max(0, Math.floor(at * 1_000));
	for (let position = 0; position < 10; position++) {
		time = CROCKFORD[milliseconds % 32] + time;
		milliseconds = Math.floor(milliseconds / 32);
	}
	let random = "";
	for (let position = 0; position < 16; position++) {
		random += CROCKFORD[digest[position]! % 32];
	}
	return time + random;
}
