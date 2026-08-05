/**
 * Validating `edit_plan` and `anchor_plan` arguments.
 *
 * The bug this guards: a model that sends `operations` as a JSON-encoded
 * string reaches `edit.apply` as a value that is not an array at all, and
 * `operations.some`/`operations.length` either throw or measure characters
 * instead of operations. These tests pin the rejection and its message, not
 * just that something throws — the message is what lets the model correct
 * itself.
 */

import { describe, expect, it } from "bun:test";

import { anchorPlan, ArgumentError, editPlan } from "./arguments";

function batch(overrides: Record<string, unknown> = {}) {
	return {
		revision: 1,
		operations: [{ op: "insert", index: 0, source: "Hi.\n" }],
		...overrides,
	};
}

describe("editPlan", () => {
	it("accepts a well-formed batch and returns the operations unchanged", () => {
		let args = editPlan(batch());

		expect(args.revision).toBe(1);
		expect(Array.isArray(args.operations)).toBe(true);
		expect(args.operations).toEqual([{ op: "insert", index: 0, source: "Hi.\n" }]);
	});

	it("rejects operations sent as a JSON-encoded string", () => {
		let source = JSON.stringify(batch().operations);
		expect(() => editPlan(batch({ operations: source }))).toThrow(ArgumentError);
		expect(() => editPlan(batch({ operations: source }))).toThrow(/`operations` must be an array/);
	});

	/**
	 * A single-operation batch, JSON-encoded, is the case that used to sail
	 * past `operations.length === 0` and `operations.length > 1` in `edit.ts`
	 * because those measured characters in the string, not operations.
	 */
	it("rejects a single-operation batch sent as a JSON string", () => {
		let source = JSON.stringify([{ op: "insert", index: 0, source: "Hi.\n" }]);
		expect(() => editPlan(batch({ operations: source }))).toThrow(/`operations` must be an array/);
	});

	it("rejects an array-like object standing in for an array", () => {
		let arrayLike = { 0: { op: "insert", index: 0, source: "Hi.\n" }, length: 1 };
		expect(() => editPlan(batch({ operations: arrayLike }))).toThrow(
			/`operations` must be an array/,
		);
	});

	it("rejects a missing operations field", () => {
		expect(() => editPlan({ revision: 1 })).toThrow(/missing field: operations/);
	});

	it("rejects an empty batch", () => {
		expect(() => editPlan(batch({ operations: [] }))).toThrow(/at least 1 operation/);
	});

	it("rejects a batch over the fifty-operation limit", () => {
		let operations = Array.from({ length: 51 }, () => ({ op: "delete", index: 0 }));
		expect(() => editPlan(batch({ operations }))).toThrow(/at most 50 operations/);
	});

	it("rejects an unknown op", () => {
		expect(() => editPlan(batch({ operations: [{ op: "vaporize", index: 0 }] })))
			.toThrow(/must be one of/);
	});

	it("rejects a move with no destination", () => {
		expect(() => editPlan(batch({ operations: [{ op: "move", index: 0 }] })))
			.toThrow(/operations\[0\]\.to.*required/);
	});

	it("rejects a replace with no index", () => {
		expect(() => editPlan(batch({ operations: [{ op: "replace", source: "x\n" }] })))
			.toThrow(/operations\[0\]\.index.*required/);
	});

	it("rejects an insert with no source", () => {
		expect(() => editPlan(batch({ operations: [{ op: "insert", index: 0 }] })))
			.toThrow(/operations\[0\]\.source.*required/);
	});

	it("rejects a detach_question with no id", () => {
		expect(() => editPlan(batch({ operations: [{ op: "detach_question" }] })))
			.toThrow(/operations\[0\]\.id.*required/);
	});

	it("rejects a missing revision", () => {
		expect(() => editPlan({ operations: batch().operations })).toThrow(/missing field: revision/);
	});

	it("rejects a revision that is not an integer", () => {
		expect(() => editPlan(batch({ revision: 1.5 }))).toThrow(/`revision` must be/);
	});

	it("rejects an unknown top-level field", () => {
		expect(() => editPlan(batch({ extra: true }))).toThrow(/unexpected field/);
	});
});

function digest(byte = "a") {
	return `sha256:${byte.repeat(64)}`;
}

describe("anchorPlan", () => {
	function anchors(overrides: Record<string, unknown> = {}) {
		return {
			revision: 1,
			anchors: [{ thread: "t1", blocks: [{ index: 0, digest: digest() }] }],
			...overrides,
		};
	}

	it("accepts a well-formed batch and returns the anchors unchanged", () => {
		let args = anchorPlan(anchors());

		expect(args.revision).toBe(1);
		expect(Array.isArray(args.anchors)).toBe(true);
		expect(args.anchors).toEqual(anchors().anchors);
	});

	it("rejects anchors sent as a JSON-encoded string", () => {
		let source = JSON.stringify(anchors().anchors);
		expect(() => anchorPlan(anchors({ anchors: source }))).toThrow(/`anchors` must be an array/);
	});

	it("rejects a missing anchors field", () => {
		expect(() => anchorPlan({ revision: 1 })).toThrow(/missing field: anchors/);
	});

	it("rejects an empty batch", () => {
		expect(() => anchorPlan(anchors({ anchors: [] }))).toThrow(/at least 1 anchor/);
	});

	it("rejects a batch over the hundred-anchor limit", () => {
		let many = Array.from({ length: 101 }, () => ({ blocks: [] }));
		expect(() => anchorPlan(anchors({ anchors: many }))).toThrow(/at most 100 anchors/);
	});

	it("rejects a digest that does not match the sha256 pattern", () => {
		expect(() =>
			anchorPlan(anchors({ anchors: [{ thread: "t1", blocks: [{ index: 0, digest: "abc" }] }] }))
		).toThrow(/sha256/);
	});

	it("rejects a missing revision", () => {
		expect(() => anchorPlan({ anchors: anchors().anchors })).toThrow(/missing field: revision/);
	});

	/** An empty `blocks` list is a real answer — reviewed and unrelated — not malformed input. */
	it("accepts an anchor with no blocks", () => {
		let args = anchorPlan(anchors({ anchors: [{ thread: "t1", blocks: [] }] }));
		expect(args.anchors[0]!.blocks).toEqual([]);
	});

	it("rejects an anchor missing blocks entirely", () => {
		expect(() => anchorPlan(anchors({ anchors: [{ thread: "t1" }] }))).toThrow(/missing field/);
	});
});
