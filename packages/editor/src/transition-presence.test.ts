import { describe, expect, test } from "bun:test";

import {
	closeDelay,
	presenceClass,
	presenceState,
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

	test("retains committed content through closing and clears it when closed", () => {
		let content = { version: 1 };
		let state: PresenceState<typeof content> = {
			immediately: false,
			input: undefined,
			phase: "closed",
			value: undefined,
		};
		state = presenceState(state, { immediately: false, type: "sync", value: content });
		expect(state).toEqual({ immediately: false, input: content, phase: "opening", value: content });
		state = presenceState(state, { type: "finish" });
		expect(state.phase).toBe("open");
		state = presenceState(state, { immediately: false, type: "sync", value: undefined });
		expect(state).toEqual({
			immediately: false,
			input: undefined,
			phase: "closing",
			value: content,
		});
		state = presenceState(state, { type: "finish" });
		expect(state).toEqual({
			immediately: false,
			input: undefined,
			phase: "closed",
			value: undefined,
		});
	});

	test("treats null as present content when undefined is the absence sentinel", () => {
		let state: PresenceState<null> = {
			immediately: false,
			input: undefined,
			phase: "closed",
			value: undefined,
		};
		state = presenceState(state, { immediately: false, type: "sync", value: null });
		expect(state.phase).toBe("opening");
		expect(state.value).toBeNull();
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
