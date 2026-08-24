import { describe, expect, test } from "bun:test";

import {
	closeDelay,
	presenceClass,
	presenceState,
	presenceValue,
	resolvedPresence,
	transitionPresence,
} from "./transition-presence";

import type { PresenceState, TransitionPresence } from "./transition-presence";

function activeValue<T>(
	presence: Exclude<TransitionPresence<T>, { phase: "closed" }>,
): T {
	return presence.value;
}

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

	test("synchronizes authoritative inputs before external timing settles the phase", () => {
		let state: PresenceState = {
			immediately: false,
			open: false,
			phase: "closed",
		};
		state = presenceState(state, { immediately: false, open: true, type: "sync" });
		expect(state).toEqual({ immediately: false, open: true, phase: "opening" });
		state = presenceState(state, { type: "finish" });
		expect(state).toEqual({ immediately: false, open: true, phase: "open" });
		state = presenceState(state, { immediately: true, open: false, type: "sync" });
		expect(state).toEqual({ immediately: true, open: false, phase: "closed" });
	});

	test("presents current content before retaining it for a close", () => {
		let committed = { version: 1 };
		let current = { version: 2 };
		expect(presenceValue(current, committed, "opening")).toBe(current);
		expect(presenceValue(undefined, committed, "closing")).toBe(committed);
		expect(presenceValue(undefined, committed, "closed")).toBeUndefined();
	});

	test("treats null as present content when undefined is the absence sentinel", () => {
		let committed = { version: 1 };
		expect(presenceValue(null, committed, "open")).toBeNull();
	});

	test("narrows active content from the presence phase", () => {
		let presence = {
			className: "is-open",
			phase: "open",
			value: "Document",
		} satisfies TransitionPresence<string>;
		expect(activeValue(presence)).toBe("Document");
	});
});

describe("close delay", () => {
	test("adds cleanup time to the authoritative duration", () => {
		expect(closeDelay(180, false)).toBe(230);
	});

	test("finishes immediately when motion is disabled", () => {
		expect(closeDelay(180, true)).toBe(0);
	});
});
