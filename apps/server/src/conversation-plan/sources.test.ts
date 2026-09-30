import { expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { assertSourceShape, validateSource } from "./sources";

function message(): Chat.Entry {
	return { id: "message-1", author: { kind: "member", handle: "maggie" }, text: "🧪 Bun", ts: 1 };
}
function source(): ConversationPlan.SourceRef {
	return {
		messageId: "message-1",
		author: { kind: "member", handle: "maggie" },
		quote: "Bun",
		start: 3,
		end: 6,
		role: "option",
	};
}

test("a source preserves an exact UTF-16 span and member attribution in a saved entry", () => {
	let saved = message();
	let citation = source();
	expect(() => validateSource(citation, saved)).not.toThrow();
	expect(citation).toEqual({
		messageId: "message-1",
		author: { kind: "member", handle: "maggie" },
		quote: "Bun",
		start: 3,
		end: 6,
		role: "option",
	});
	expect(() => validateSource({ ...citation, quote: "🧪", start: 0, end: 2 }, saved)).not.toThrow();
});

test("an agent source must cite a complete saved agent entry", () => {
	let saved: Chat.Entry = { ...message(), author: { kind: "agent" } };
	let citation: ConversationPlan.SourceRef = { ...source(), author: { kind: "agent" } };
	expect(() => validateSource(citation, saved)).not.toThrow();
	expect(() => validateSource(citation, { ...saved, streaming: true }))
		.toThrow(/does not match saved message/);
	expect(() => validateSource(citation, { ...saved, streaming: false })).not.toThrow();
});

test("saved message identity, text, and attribution must all match the source", () => {
	let saved = message();
	for (
		let citation of [
			{ ...source(), messageId: "another-message" },
			{ ...source(), quote: "Deno", end: 7 },
			{ ...source(), author: { kind: "agent" as const } },
			{ ...source(), author: { kind: "member" as const, handle: "spoofed" } },
			{ ...source(), start: 4, end: 7 },
		]
	) expect(() => validateSource(citation, saved)).toThrow(/does not match saved message/);
	expect(() => validateSource(source(), { ...saved, streaming: true }))
		.toThrow(/does not match saved message/);
	expect(() => validateSource(source(), { ...saved, author: { kind: "system" } }))
		.toThrow(/does not match saved message/);
});

test("source shape bounds message IDs, quotes, and safe UTF-16 offsets", () => {
	expect(() =>
		assertSourceShape({
			...source(),
			messageId: "x".repeat(200),
			quote: "x".repeat(2048),
			start: 0,
			end: 2048,
		})
	)
		.not.toThrow();
	for (
		let override of [
			{ messageId: "" },
			{ messageId: "x".repeat(201) },
			{ messageId: 1 },
			{ quote: "" },
			{ quote: "x".repeat(2049), start: 0, end: 2049 },
			{ quote: 1 },
			{ start: -1, end: 2 },
			{ start: 3.5, end: 6.5 },
			{ start: 3, end: 3 },
			{ start: 6, end: 3 },
			{ end: 7 },
			{ start: Number.NaN },
			{ start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 4 },
		]
	) {
		expect(() => assertSourceShape({ ...source(), ...override })).toThrow(
			/invalid conversation source/,
		);
	}
});

test("source shape rejects missing fields and unknown source or author fields", () => {
	for (let field of ["messageId", "author", "quote", "start", "end", "role"]) {
		let value: Record<string, unknown> = { ...source() };
		delete value[field];
		expect(() => assertSourceShape(value)).toThrow(/invalid conversation source/);
	}
	expect(() => assertSourceShape({ ...source(), classifierText: "Bun" }))
		.toThrow(/unknown conversation source field/);
	expect(() =>
		assertSourceShape({ ...source(), author: { kind: "member", handle: "maggie", extra: true } })
	)
		.toThrow(/unknown conversation source author field/);
	expect(() => assertSourceShape({ ...source(), author: { kind: "agent", handle: "maggie" } }))
		.toThrow(/unknown conversation source author field/);
});

test("source roles and authors follow the archived allowlist", () => {
	let roles: ConversationPlan.SourceRole[] = [
		"question",
		"option",
		"reason",
		"constraint",
		"support",
		"objection",
		"withdrawal",
		"verification",
		"resolution",
		"reopening",
	];
	for (let role of roles) expect(() => assertSourceShape({ ...source(), role })).not.toThrow();
	for (
		let value of [
			{ ...source(), role: "decision" },
			{ ...source(), author: { kind: "system" } },
			{ ...source(), author: { kind: "classifier" } },
			{ ...source(), author: { kind: "member", handle: "" } },
			{ ...source(), author: { kind: "member", handle: 1 } },
			null,
			[],
		]
	) expect(() => assertSourceShape(value)).toThrow(/invalid conversation source/);
});
