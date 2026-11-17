import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";

import { validateNotice } from "./notice-validation";

function notice(comment: Record<string, unknown>) {
	return { author: { kind: "system" }, comment } as never;
}

test("a comment notice may name the child holding its thread, and only by channel id", () => {
	let base = { thread: ulid(), excerpt: "the passage", note: "Tighten this." };
	let child = "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b";
	expect(() => validateNotice(notice(base), new Map())).not.toThrow();
	expect(() => validateNotice(notice({ ...base, channelId: child }), new Map())).not.toThrow();
	for (let channelId of ["not-a-channel", 3, null]) {
		expect(() => validateNotice(notice({ ...base, channelId }), new Map())).toThrow();
	}
	expect(() => validateNotice(notice({ ...base, other: child }), new Map())).toThrow();
});

test("a created-document notice names the document by channel id, title and its path", () => {
	let created = {
		channelId: "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b",
		title: "Settings page",
		path: "/documents/octo/app/settings-page",
	};
	let entry = (document: unknown, kind = "system") =>
		({ author: { kind }, text: "chopin created Settings page for @mona.", document }) as never;
	expect(() => validateNotice(entry(created), new Map())).not.toThrow();
	for (
		let invalid of [
			{ ...created, channelId: "not-a-channel" },
			{ ...created, path: "https://example.test/documents/octo/app/x" },
			{ ...created, path: "/documents/octo/app" },
			{ ...created, title: "x".repeat(51) },
			{ ...created, other: true },
			{ channelId: created.channelId, title: created.title },
			null,
		]
	) expect(() => validateNotice(entry(invalid), new Map())).toThrow();
	expect(() => validateNotice(entry(created, "agent"), new Map())).toThrow();
});
