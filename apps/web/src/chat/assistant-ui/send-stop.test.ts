import { describe, expect, test } from "bun:test";

import { announcement, sendStop } from "./send-stop";

import type { SendStopInput } from "./send-stop";

/** A Planner at rest, a draft with words in it, and nothing in the way of sending or stopping. */
const READY: SendStopInput = { running: false, hasDraft: true, canSend: true, canStop: true };

describe("the one button turns from send into stop", () => {
	test("sends while the Planner is idle, and waits for a draft to send", () => {
		expect(sendStop(READY)).toEqual({ action: "send", disabled: false });
		expect(sendStop({ ...READY, hasDraft: false, canSend: false })).toEqual({
			action: "send",
			disabled: true,
		});
	});

	test("stops a running Planner while the draft is empty", () => {
		expect(sendStop({ ...READY, running: true, hasDraft: false, canSend: false })).toEqual({
			action: "stop",
			disabled: false,
		});
	});

	test("sends a message while the Planner runs, and goes back to stop once the draft is gone", () => {
		let typing = { ...READY, running: true };
		expect(sendStop(typing)).toEqual({ action: "send", disabled: false });
		// Sent, or cleared: the draft is empty again.
		expect(sendStop({ ...typing, hasDraft: false, canSend: false }).action).toBe("stop");
	});

	test("shows a disabled send, never a stop, to someone who may not stop the Planner", () => {
		let barred = { ...READY, running: true, hasDraft: false, canSend: false, canStop: false };
		expect(sendStop(barred)).toEqual({ action: "send", disabled: true });
	});

	test("keeps a draft's send disabled while it cannot be sent, instead of offering to stop", () => {
		// A send in flight, a command nothing can run, or a connection that has gone.
		let blocked = { ...READY, running: true, canSend: false };
		expect(sendStop(blocked)).toEqual({ action: "send", disabled: true });
	});

	test("lets a person who may stop do so, whatever the draft's send is blocked by", () => {
		let offline = { running: true, hasDraft: false, canSend: false, canStop: true };
		expect(sendStop(offline)).toEqual({ action: "stop", disabled: false });
	});
});

describe("a screen reader is told once when the button changes", () => {
	test("says nothing about the button as it first appears", () => {
		expect(announcement(undefined, "send")).toBeUndefined();
		expect(announcement(undefined, "stop")).toBeUndefined();
	});

	test("says nothing while the action stays the same, as it does for every token of a reply", () => {
		expect(announcement("stop", "stop")).toBeUndefined();
		expect(announcement("send", "send")).toBeUndefined();
	});

	test("says what the button became, in the words of its name", () => {
		expect(announcement("send", "stop")).toBe("Stop generating");
		expect(announcement("stop", "send")).toBe("Send message");
	});
});
