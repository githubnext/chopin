import { describe, expect, test } from "bun:test";

import { closeDelay, presenceClass, transitionPresence } from "./transition-presence";

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
