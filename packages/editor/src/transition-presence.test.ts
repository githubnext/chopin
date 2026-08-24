import { expect, test } from "bun:test";

import { presenceState } from "./transition-presence";

import type { PresenceState } from "./transition-presence";

function closed<T>(): PresenceState<T> {
	return {
		immediately: false,
		input: undefined,
		phase: "closed",
		value: undefined,
	};
}

test("closing retains content until it finishes", () => {
	let content = { version: 1 };
	let state = presenceState(closed<typeof content>(), {
		immediately: false,
		type: "sync",
		value: content,
	});
	state = presenceState(state, { type: "finish" });
	state = presenceState(state, { immediately: false, type: "sync", value: undefined });
	expect(state.phase).toBe("closing");
	expect(state.value).toBe(content);

	state = presenceState(state, { type: "finish" });
	expect(state.phase).toBe("closed");
	expect(state.value).toBeUndefined();
});

test("reopening cancels a close", () => {
	let first = { version: 1 };
	let replacement = { version: 2 };
	let state = presenceState(closed<typeof first>(), {
		immediately: false,
		type: "sync",
		value: first,
	});
	state = presenceState(state, { type: "finish" });
	state = presenceState(state, { immediately: false, type: "sync", value: undefined });
	state = presenceState(state, { immediately: false, type: "sync", value: replacement });
	expect(state.phase).toBe("open");
	expect(state.value).toBe(replacement);
});

test("immediate paths skip transitional states", () => {
	let state = presenceState(closed<string>(), {
		immediately: true,
		type: "sync",
		value: "Document",
	});
	expect(state.phase).toBe("open");

	state = presenceState(state, { immediately: true, type: "sync", value: undefined });
	expect(state.phase).toBe("closed");
	expect(state.value).toBeUndefined();
});

test("null is content and undefined is absence", () => {
	let state = presenceState(closed<null>(), {
		immediately: false,
		type: "sync",
		value: null,
	});
	expect(state.phase).toBe("opening");
	expect(state.value).toBeNull();
});
