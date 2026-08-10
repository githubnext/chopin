import { describe, expect, it } from "bun:test";

import { displayText, duration, group, summarize } from "./model";

import type { Chat } from "@chopin/protocol";

function entry(id: string, author: Chat.Author, text = id): Chat.Entry {
	return { id, author, text, ts: 1_700_000_000 };
}

describe("transcript groups", () => {
	it("puts consecutive messages from one author in one group", () => {
		let result = group([
			entry("m1", { kind: "member", handle: "ana" }),
			entry("m2", { kind: "member", handle: "ana" }),
			entry("m3", { kind: "agent" }),
		], []);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			kind: "messages",
			messages: [{ id: "m1" }, { id: "m2" }],
		});
	});

	it("starts a new group when a system line interrupts an author", () => {
		let result = group([
			entry("m1", { kind: "member", handle: "ana" }),
			entry("s1", { kind: "system" }),
			entry("m2", { kind: "member", handle: "ana" }),
		], []);

		expect(result.map(item => item.kind)).toEqual(["messages", "system", "messages"]);
	});

	it("groups queued messages separately from sent messages", () => {
		let result = group(
			[entry("m1", { kind: "member", handle: "ana" })],
			[
				{ id: "q1", handle: "ana", text: "one" },
				{ id: "q2", handle: "ana", text: "two" },
			],
		);

		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({ queued: true, messages: [{ id: "q1" }, { id: "q2" }] });
	});
});

describe("rail copy", () => {
	it("removes addressing symbols while leaving email addresses alone", () => {
		expect(displayText("@ai ask @sam; email me@site.dev")).toBe("ask Sam; email me@site.dev");
	});

	it("formats subsecond and second durations compactly", () => {
		expect([duration(38), duration(1_200), duration(9_200)]).toEqual(["38ms", "1.2s", "9.2s"]);
	});
});

describe("tool-run summaries", () => {
	it("names only the live tool while a run is active", () => {
		expect(summarize([
			{ id: "t1", name: "read_file", status: "done", took: 38 },
			{ id: "t2", name: "edit_plan", status: "running" },
		])).toEqual({ state: "running", name: "edit_plan", completed: 1 });
	});

	it("reports counts, failures and elapsed time after the run", () => {
		expect(summarize([
			{ id: "t1", name: "read_file", status: "done", took: 38 },
			{ id: "t2", name: "edit_plan", status: "failed", took: 1_200 },
		])).toEqual({ state: "finished", count: 2, failures: 1, elapsed: 1_238 });
	});
});
