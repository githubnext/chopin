import { describe, expect, it } from "bun:test";

import { deterministicChannelId, isChannelId, newChannelId } from "./id";

describe("channel ids", () => {
	it("accepts canonical UUIDv5 and legacy UUIDv4 channel ids", () => {
		expect(isChannelId("019c1234-1234-4123-8123-123456789abc")).toBe(true);
		expect(isChannelId("019c1234-1234-5123-8123-123456789abc")).toBe(true);
		expect(isChannelId("019c1234-1234-3123-8123-123456789abc")).toBe(false);
		expect(isChannelId("019c1234-1234-5123-7123-123456789abc")).toBe(false);
		expect(isChannelId("not-a-channel")).toBe(false);
	});

	it("mints fresh UUIDv5 channel ids", () => {
		let first = newChannelId("R_score");
		let second = newChannelId("R_score");
		expect(first[14]).toBe("5");
		expect(isChannelId(first)).toBe(true);
		expect(second).not.toBe(first);
	});

	it("derives a stable repository-scoped idempotent creation id", () => {
		let id = deterministicChannelId("R_score", "attempt-1");
		expect(id).toBe("ba0d561e-c15d-522f-a4ea-e83f72584327");
		expect(isChannelId(id)).toBe(true);
		expect(deterministicChannelId("R_score", "attempt-1")).toBe(id);
		expect(deterministicChannelId("R_other", "attempt-1")).not.toBe(id);
		expect(deterministicChannelId("R_score", "attempt-2")).not.toBe(id);
	});
});
