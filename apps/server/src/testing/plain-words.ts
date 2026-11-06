import { expect } from "bun:test";

import { INTERNAL, INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

type Line = { author: { kind: string }; text: string };

/** A line a person reads, from the server, names none of Chopin's own terms. */
export function expectPlain(text: string, where = "a line a person reads"): void {
	expect(INTERNAL.test(text), `${where}: "${text}"`).toBe(false);
}

/** The same, for a line about a machine or its connection, which does not say Decision either. */
export function expectPlainStatus(text: string, where = "a line about a machine"): void {
	expect(INTERNAL_IN_STATUS.test(text), `${where}: "${text}"`).toBe(false);
}

/** Every line the server wrote into Chat on its own behalf is plain; what members said is theirs. */
export function expectPlainLines(entries: readonly Line[]): void {
	for (let entry of entries) {
		if (entry.author.kind === "system") expectPlain(entry.text, "a Chat line from the server");
	}
}

/** The Chat lines about a machine and its connection (stopping and resuming its work). */
export function expectPlainStatusLines(entries: readonly Line[]): void {
	for (let entry of entries) {
		if (entry.author.kind === "system") {
			expectPlainStatus(entry.text, "a Chat line about a machine");
		}
	}
}
