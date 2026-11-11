import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";

import { sourceHash } from "../plan/service";
import { restoreReferences } from "./references";
import { entriesForStorage, mergePointers } from "./stored-pointers";

import type { Chat as Wire } from "@chopin/protocol";
import type { JsonValue } from "../storage/model";

const TEXT = "/review #Target @Overview %Brief @src/index.ts @Rollout";

function at(token: string) {
	return { start: TEXT.indexOf(token), end: TEXT.indexOf(token) + token.length };
}

const COMMAND: Wire.CommandReference = {
	kind: "command",
	id: ulid(),
	label: "/review",
	name: "review",
	commandKind: "prompt",
	...at("/review"),
};
const DOCUMENT: Wire.DocumentReference = {
	id: ulid(),
	kind: "document",
	label: "#Target",
	href: "/documents/octo-org/score/target",
	repositoryId: "R_same",
	observedRevision: 2,
	channelId: crypto.randomUUID(),
	observedSourceHash: sourceHash("Target.\n"),
	...at("#Target"),
};
const HEADING: Wire.HeadingReference = {
	kind: "heading",
	id: ulid(),
	label: "@Overview",
	anchor: "overview",
	level: 1,
	line: 1,
	...at("@Overview"),
};
const FILE: Wire.FileReference = {
	kind: "file",
	id: ulid(),
	label: "@src/index.ts",
	path: "src/index.ts",
	...at("@src/index.ts"),
};
const DECISION: Wire.DecisionReference = {
	kind: "decision",
	id: ulid(),
	label: "@Rollout",
	decisionId: "01HQ0000000000000000000000",
	...at("@Rollout"),
};
const RESEARCH = {
	kind: "research",
	id: ulid(),
	label: "%Brief",
	href: "/research/workspace-1",
	repositoryId: "R_same",
	observedRevision: 1,
	parentChannelId: crypto.randomUUID(),
	workspaceId: "workspace-1",
	...at("%Brief"),
} as unknown as Wire.ResearchReference;

function entry(references?: Wire.Reference[], text = TEXT): Wire.Entry {
	return {
		id: ulid(),
		author: { kind: "member", handle: "ana" },
		text,
		ts: 1_700_000_000,
		...(references ? { references } : {}),
	};
}

/** Stored, as the sidecar is written and read back, and restored. */
function roundTrip(entries: Wire.Entry[]): Array<Record<string, JsonValue>> {
	let stored = JSON.parse(JSON.stringify(entriesForStorage(entries))) as Array<
		Record<string, JsonValue>
	>;
	for (let item of stored) mergePointers(item);
	return stored;
}

describe("pointers in a stored transcript", () => {
	it("keep a server without them able to read it: only documents and research stay in `references`", () => {
		let all = [COMMAND, DOCUMENT, HEADING, RESEARCH, FILE, DECISION];
		let [stored] = entriesForStorage([entry(all)]) as Array<Record<string, unknown>>;
		expect((stored!.references as Wire.Reference[]).map(item => item.kind)).toEqual([
			"document",
			"research",
		]);
		expect((stored!.pointers as Wire.Reference[]).map(item => item.kind)).toEqual([
			"command",
			"heading",
			"file",
			"decision",
		]);
	});

	it("come back exactly as they were, among the references of the older kinds, in the order of the text", () => {
		let all = [COMMAND, DOCUMENT, HEADING, RESEARCH, FILE, DECISION];
		let [restored] = roundTrip([entry(all)]);
		expect(restored!.references).toEqual(all as unknown as JsonValue[]);
		expect(Object.hasOwn(restored!, "pointers")).toBe(false);
	});

	it("are restored by the strict reader that checks every range, label and identity", () => {
		let all = [COMMAND, DOCUMENT, HEADING, FILE, DECISION];
		let text = "/review #Target @Overview @src/index.ts @Rollout";
		let [restored] = roundTrip([
			entry(all.map(item => ({ ...item, ...position(text, item.label) })), text),
		]);
		expect(restoreReferences(restored!.references, text)).toEqual(
			all.map(item => ({ ...item, ...position(text, item.label) })),
		);
	});

	it("leave a message with only pointers with no `references` for the older server to check", () => {
		let [stored] = entriesForStorage([entry([HEADING, FILE])]) as Array<Record<string, unknown>>;
		expect(Object.hasOwn(stored!, "references")).toBe(false);
		let [restored] = roundTrip([entry([HEADING, FILE])]);
		expect(restored!.references).toEqual([HEADING, FILE] as unknown as JsonValue[]);
	});

	it("leave a message that has none exactly as it is", () => {
		let plain = entry();
		let linked = entry([DOCUMENT, RESEARCH]);
		let stored = entriesForStorage([plain, linked]);
		expect(stored[0]).toBe(plain);
		expect(stored[1]).toBe(linked);
		expect(Object.hasOwn(stored[1]!, "pointers")).toBe(false);
	});

	it("are refused when what is stored under `pointers` is not a list", () => {
		expect(() => mergePointers({ pointers: "nothing" })).toThrow("invalid transcript reference");
	});
});

function position(text: string, label: string) {
	return { start: text.indexOf(label), end: text.indexOf(label) + label.length };
}
