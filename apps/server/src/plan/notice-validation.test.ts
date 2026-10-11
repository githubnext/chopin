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
