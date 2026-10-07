import { expect, test } from "bun:test";
import * as Draft from "./index";

test("concurrent insertions merge and repeated patch delivery is idempotent", () => {
	let original = Draft.create("Compare Jev.");
	let alice = original.fork();
	let bob = original.fork();
	let a = Draft.change(alice, "Compare self-hosted Jev.")!;
	let b = Draft.change(bob, "Compare Jev alternatives.")!;
	let first = Draft.apply(Draft.apply(original, a), b);
	let second = Draft.apply(Draft.apply(original, b), a);
	expect(Draft.read(first)).toBe("Compare self-hosted Jev alternatives.");
	expect(Draft.read(second)).toBe(Draft.read(first));
	expect(Draft.binary(Draft.apply(first, a))).toEqual(Draft.binary(first));
});

test.each(["", "😀 multilingual 日本語", "line one\nline two", "a😀b", "a😎b"])(
	"text splices round-trip %s",
	value => {
		let model = Draft.create("a😀b").fork();
		let patch = Draft.change(model, value);
		if (patch) model = Draft.apply(model, patch);
		expect(Draft.read(Draft.restore(Draft.binary(model)))).toBe(value);
	},
);

test("malformed and oversized patches cannot mutate the original model", () => {
	let model = Draft.create("original");
	expect(() => Draft.apply(model, [999])).toThrow();
	expect(() => Draft.change(model, "x".repeat(Draft.MAX_TEXT + 1))).toThrow();
	expect(Draft.read(model)).toBe("original");
});
