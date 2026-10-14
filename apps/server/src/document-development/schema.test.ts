import { expect, test } from "bun:test";
import type { JsonValue } from "../storage/model";
import {
	type DocumentDevelopmentInput,
	parseDocumentDevelopmentArtifact,
	parseDocumentDevelopmentInput,
	parseDocumentDevelopmentOutput,
} from "./schema";

export function input(): DocumentDevelopmentInput {
	return {
		messageId: "m2",
		revision: 4,
		decisionHash: `sha256:${"a".repeat(64)}`,
		capacity: { additions: 48, characters: 12000 },
		source: "# Test\n\nA human paragraph.\n\nProposal: keep the editor open.",
		messages: [
			{ id: "m1", author: "ana", text: "I would close the editor while saving." },
			{ id: "m2", author: "bea", text: "I disagree: keep it open. Earlier I said otherwise." },
		],
		passages: [
			{ id: "owned", markdown: "Proposal: close the editor.", digest: "baseline", editable: true },
			{ id: "human", markdown: "A human paragraph.", digest: "protected", editable: false },
		],
		decisions: ["Preserve text during saving."],
	};
}

let change = () => ({
	id: "owned",
	markdown: "Proposal: keep the editor open.",
	sourceIds: ["m2"],
});

test("input retains bounded immutable context and rejects extra capabilities", () => {
	let original = input();
	let parsed = parseDocumentDevelopmentInput(original);
	expect(parsed).toEqual(original);
	parsed.messages[0]!.text = "mutated";
	expect(original.messages[0]!.text).not.toBe("mutated");
	expect(parseDocumentDevelopmentInput({ ...input(), source: "" }).source).toBe("");
	for (
		let invalid of [
			{ ...input(), token: "secret" },
			{ ...input(), revision: -1 },
			{ ...input(), decisionHash: "not-a-hash" },
			{ ...input(), messageId: "m1" },
			{ ...input(), messages: [] },
			{ ...input(), messages: [{ id: "m2", author: "a", text: "", tools: [] }] },
			{ ...input(), passages: [{ ...input().passages[0]!, editable: "true" }] },
			{ ...input(), passages: [input().passages[0]!, input().passages[0]!] },
		]
	) expect(() => parseDocumentDevelopmentInput(invalid)).toThrow();
});

test("input rejects oversized source, identities, message windows and decision context", () => {
	let oversized: JsonValue[] = [
		{ ...input(), source: "x".repeat(32001) },
		{ ...input(), messageId: "m".repeat(129) },
		{ ...input(), messages: [{ id: "m2", author: "a", text: "x".repeat(4001) }] },
		{
			...input(),
			messages: Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, author: "a", text: "x" })),
		},
		{
			...input(),
			messageId: "m4",
			messages: Array.from(
				{ length: 5 },
				(_, i) => ({ id: `m${i}`, author: "a", text: "x".repeat(4000) }),
			),
		},
		{ ...input(), passages: [{ ...input().passages[0]!, markdown: "x".repeat(1201) }] },
		{
			...input(),
			passages: Array.from({ length: 49 }, (_, i) => ({ ...input().passages[0]!, id: `p${i}` })),
		},
		{ ...input(), decisions: Array.from({ length: 25 }, () => "A decision") },
		{ ...input(), decisions: ["x".repeat(801)] },
	];
	for (let value of oversized) expect(() => parseDocumentDevelopmentInput(value)).toThrow();
});

test("only known editable passages and supplied distinct sources can change", () => {
	let accepted = { changes: [change(), { ...change(), id: null }], removals: [] };
	expect(parseDocumentDevelopmentOutput(accepted, input())).toEqual(accepted);
	expect(parseDocumentDevelopmentOutput({ changes: [], removals: [] }, input())).toEqual({
		changes: [],
		removals: [],
	});
	for (
		let invalid of [
			{ changes: [{ ...change(), id: "human" }], removals: [] },
			{ changes: [{ ...change(), id: "missing" }], removals: [] },
			{ changes: [], removals: ["human"] },
			{ changes: [], removals: ["missing"] },
			{ changes: [change(), change()], removals: [] },
			{ changes: [change()], removals: ["owned"] },
			{ changes: [], removals: ["owned", "owned"] },
			{ changes: [{ ...change(), sourceIds: [] }], removals: [] },
			{ changes: [{ ...change(), sourceIds: ["m2", "m2"] }], removals: [] },
			{ changes: [{ ...change(), sourceIds: ["invented"] }], removals: [] },
			{ changes: [change()], removals: [], model: "untrusted" },
			{ changes: [{ ...change(), instructions: "execute" }], removals: [] },
		] as JsonValue[]
	) expect(() => parseDocumentDevelopmentOutput(invalid, input())).toThrow();
});

test("proposals allow ordinary prose and safe links but reject unsupported nested markup", () => {
	for (
		let markdown of [
			"Plain **prose** with `code`.",
			"## Working approach",
			"### Open question",
			"- First\n- Second",
			"[Evidence](https://example.com)",
		]
	) {
		expect(() =>
			parseDocumentDevelopmentOutput(
				{ changes: [{ ...change(), markdown }], removals: [] },
				input(),
			)
		).not.toThrow();
	}
	for (
		let markdown of [
			"# New title",
			"#### Deep heading",
			"First\n\nSecond",
			"---",
			"> A quote",
			"```ts\nlet x = 1;\n```",
			'<Callout id="01ARZ3NDEKTSV4RRFFQ69G5FAV">Hidden</Callout>',
			"Prose <strong>HTML</strong>.",
			"- Item\n\n  <Callout>Nested</Callout>",
			"- Item\n\n  ```\n  code\n  ```",
			"| A | B |\n| - | - |\n| a | b |",
			"![image](https://example.com/a.png)",
			"[unsafe](javascript:alert)",
			"[unsafe](//evil.example)",
			"[unsafe](\\\\evil.example)",
		]
	) {
		expect(() =>
			parseDocumentDevelopmentOutput(
				{ changes: [{ ...change(), markdown }], removals: [] },
				input(),
			)
		).toThrow();
	}
});

test("combined change and text bounds apply to durable artifacts too", () => {
	let artifact = { ...input(), changes: [], removals: [], model: "fixture" };
	let { messageId, revision, decisionHash, model } = artifact;
	let identity = { messageId, revision, decisionHash, model };
	expect(parseDocumentDevelopmentArtifact({ ...identity, changes: [], removals: [] })).toEqual({
		...identity,
		changes: [],
		removals: [],
	});
	for (
		let output of [
			{ changes: Array.from({ length: 9 }, () => ({ ...change(), id: null })), removals: [] },
			{
				changes: Array.from({ length: 8 }, () => ({ ...change(), id: null })),
				removals: ["owned"],
			},
			{ changes: [{ ...change(), markdown: "x".repeat(1201) }], removals: [] },
			{
				changes: Array.from(
					{ length: 5 },
					() => ({ ...change(), id: null, markdown: "x".repeat(1000) }),
				),
				removals: [],
			},
		]
	) expect(() => parseDocumentDevelopmentArtifact({ ...identity, ...output })).toThrow();
	expect(() =>
		parseDocumentDevelopmentArtifact({ ...identity, changes: [], removals: [], token: "secret" })
	).toThrow();
});

test("capacity is strict and counts net canonical Markdown including its trailing newline", () => {
	let material = input();
	for (
		let capacity of [
			{ additions: -1, characters: 0 },
			{ additions: 49, characters: 0 },
			{ additions: 0, characters: 12001 },
			{ additions: 0, characters: 0, extra: true },
		] as JsonValue[]
	) expect(() => parseDocumentDevelopmentInput({ ...material, capacity })).toThrow();
	let { capacity: _capacity, ...missing } = material;
	expect(() => parseDocumentDevelopmentInput(missing)).toThrow();
	material.capacity = { additions: 0, characters: 0 };
	expect(() =>
		parseDocumentDevelopmentOutput(
			{ changes: [{ ...change(), markdown: "Brief." }], removals: [] },
			material,
		)
	).not.toThrow();
	expect(() =>
		parseDocumentDevelopmentOutput({ changes: [{ ...change(), id: null }], removals: [] }, material)
	).toThrow("capacity");
	material.capacity = { additions: 1, characters: 5 };
	expect(() =>
		parseDocumentDevelopmentOutput({
			changes: [{ ...change(), id: null, markdown: "Tiny." }],
			removals: [],
		}, material)
	).toThrow("capacity");
	material.capacity.characters = 6;
	expect(() =>
		parseDocumentDevelopmentOutput({
			changes: [{ ...change(), id: null, markdown: "Tiny." }],
			removals: [],
		}, material)
	).not.toThrow();
	material.capacity = { additions: 0, characters: 0 };
	expect(() => parseDocumentDevelopmentOutput({ changes: [], removals: ["owned"] }, material)).not
		.toThrow();
});
