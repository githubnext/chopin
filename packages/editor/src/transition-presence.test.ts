import { describe, expect, test } from "bun:test";

import {
	closeDelay,
	presenceClass,
	presenceValue,
	resolvedPresence,
	transitionPresence,
} from "./transition-presence";

describe("transition presence", () => {
	test("opens on a frame and closes after its exit", () => {
		expect(presenceClass("closed")).toBe("");
		let phase = transitionPresence("closed", "open");
		expect(phase).toBe("opening");
		expect(presenceClass(phase)).toBe("");
		phase = transitionPresence(phase, "finish");
		expect(phase).toBe("open");
		expect(presenceClass(phase)).toBe("is-open");
		phase = transitionPresence(phase, "close");
		expect(phase).toBe("closing");
		expect(presenceClass(phase)).toBe("is-closing");
		expect(transitionPresence(phase, "finish")).toBe("closed");
	});

	test("reopening cancels a close", () => {
		expect(transitionPresence("closing", "open")).toBe("open");
	});

	test("presents a close before its reducer state updates", () => {
		expect(resolvedPresence("open", false, false)).toBe("closing");
	});

	test("keeps an ordinary opening phase until the frame finishes it", () => {
		let phase = transitionPresence("closed", "open");
		expect(resolvedPresence(phase, true, false)).toBe("opening");
		phase = transitionPresence(phase, "finish");
		expect(resolvedPresence(phase, true, false)).toBe("open");
	});

	test("keeps opening when its defined content changes identity", () => {
		let phase = transitionPresence("closed", "open");
		let initial = {};
		let replacement = {};
		expect(resolvedPresence(phase, initial !== undefined, false)).toBe("opening");
		expect(resolvedPresence(phase, replacement !== undefined, false)).toBe("opening");
	});

	test("settles immediate paths without an intermediate phase", () => {
		expect(resolvedPresence("closed", true, true)).toBe("open");
		expect(resolvedPresence("open", false, true)).toBe("closed");
	});

	test("presents current content before retaining it for a close", () => {
		let committed = { version: 1 };
		let current = { version: 2 };
		expect(presenceValue(current, committed, "opening")).toBe(current);
		expect(presenceValue(undefined, committed, "closing")).toBe(committed);
		expect(presenceValue(undefined, committed, "closed")).toBeUndefined();
	});
});

describe("close delay", () => {
	test.each(
		[
			["180ms", 230],
			["0.2s", 250],
		] as const,
	)("adds cleanup time to a %s duration", (duration, expected) => {
		expect(closeDelay(duration, 300, false)).toBe(expected);
	});

	test("finishes immediately when motion is disabled", () => {
		expect(closeDelay("0.2s", 300, true)).toBe(0);
	});
});
