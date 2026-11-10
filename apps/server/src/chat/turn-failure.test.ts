import { expect, test } from "bun:test";

import { PlannerReplyError } from "./reply-policy";
import { turnFailureOf } from "./turn-failure";

const BASE = { suspended: false, request: "req-1", focus: "child-1" };

test("a model or harness failure carries the words it reported, and the turn it ended", () => {
	expect(turnFailureOf({ ...BASE, error: new Error("429 Too Many Requests") })).toEqual({
		kind: "error",
		detail: "429 Too Many Requests",
		request: "req-1",
		focus: "child-1",
	});
});

test("a failure that is not an error says the agent could not be reached, with no words of its own", () => {
	expect(turnFailureOf({ ...BASE, error: "gone" })).toEqual({
		kind: "unreachable",
		request: "req-1",
		focus: "child-1",
	});
});

test("a turn that took too long is timed out, however the timeout is worded", () => {
	for (
		let message of [
			"Request timed out",
			"ETIMEDOUT",
			"The operation timed out after 30s",
			"deadline exceeded",
		]
	) {
		expect(turnFailureOf({ ...BASE, error: new Error(message) }).kind).toBe("timed-out");
	}
	let named = new Error("aborted");
	named.name = "TimeoutError";
	expect(turnFailureOf({ ...BASE, error: named }).kind).toBe("timed-out");
});

test("a tool the turn was refused, and a tool it needed that is not offered, end it with no server jargon attached", () => {
	let refused = turnFailureOf({
		...BASE,
		error: new Error("aborted"),
		interruption: "Chopin's tool approval was denied.",
	});
	expect(refused).toEqual({ kind: "refused", request: "req-1", focus: "child-1" });
	let tool = turnFailureOf({
		...BASE,
		error: new Error("aborted"),
		interruption: "Chopin's tool boundary failure: bash",
	});
	expect(tool).toEqual({ kind: "tool", request: "req-1", focus: "child-1" });
});

test("a machine whose connection dropped under the reply is dropped, not a failure of the reply", () => {
	expect(turnFailureOf({ ...BASE, suspended: true, error: new Error("link closed") })).toEqual({
		kind: "dropped",
		request: "req-1",
		focus: "child-1",
	});
});

test("a reply the check could not verify says nothing in the server's words", () => {
	expect(turnFailureOf({ ...BASE, error: new PlannerReplyError("Chopin could not verify") }))
		.toEqual({ kind: "error", request: "req-1", focus: "child-1" });
});

test("a turn nobody typed has no request or focus to retry", () => {
	expect(turnFailureOf({ suspended: false, error: new Error("boom") })).toEqual({
		kind: "error",
		detail: "boom",
	});
});

test("an interruption that is not a refusal, such as a restart, is an error with no detail of the server's", () => {
	expect(
		turnFailureOf({ ...BASE, error: new Error("aborted"), interruption: "Chopin is restarting." }),
	).toEqual({ kind: "error", request: "req-1", focus: "child-1" });
});
