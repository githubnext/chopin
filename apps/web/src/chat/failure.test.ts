import { expect, test } from "bun:test";

import { INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

import { failureBanner, failureView, sendFailureView, withoutFailure } from "./failure";
import { sendFailure } from "./references";
import { WireRefusal } from "../wire";

import type { Chat } from "@chopin/protocol";

function member(id: string, handle: string, extra: Partial<Chat.Entry> = {}): Chat.Entry {
	return { id, author: { kind: "member", handle }, text: `from ${id}`, ts: 1, ...extra };
}
function agent(id: string): Chat.Entry {
	return { id, author: { kind: "agent" }, text: "done", ts: 2 };
}
function failed(id: string, failure: Chat.TurnFailure): Chat.Entry {
	return {
		id,
		author: { kind: "system" },
		text: "The agent could not be reached.",
		ts: 3,
		turnFailure: failure,
	};
}

const ASK = member("ask", "mona", { to: "planner" });

test("each kind of failed reply says what happened in a machine's plain words", () => {
	let kinds = ["error", "refused", "tool", "timed-out", "unreachable"] as const;
	for (let kind of kinds) {
		let view = failureView({ kind })!;
		expect(view.kind).toBe(kind);
		expect(view.title.length).toBeGreaterThan(0);
		// None of Chopin's own terms, as for every word about a machine and its connection.
		expect(INTERNAL_IN_STATUS.test(`${view.title} ${view.detail ?? ""}`)).toBe(false);
	}
});

test("a model or harness error keeps the words it reported, exactly", () => {
	expect(failureView({ kind: "error", detail: "429 Too Many Requests: slow down" })).toMatchObject({
		title: "Couldn't finish the reply.",
		detail: "429 Too Many Requests: slow down",
		retry: true,
	});
	expect(failureView({ kind: "error" })?.detail).toBeUndefined();
});

test("a timed-out, unreachable or tool-failed reply can be asked again; a refused one cannot help by repeating", () => {
	expect(failureView({ kind: "timed-out" })).toMatchObject({
		title: "The reply took too long.",
		retry: true,
	});
	expect(failureView({ kind: "unreachable" })).toMatchObject({ retry: true });
	expect(failureView({ kind: "tool" })).toMatchObject({ retry: true });
	expect(failureView({ kind: "refused" })).toMatchObject({ retry: false });
});

test("a machine whose connection dropped under the reply is the connection's to tell, never a failure", () => {
	expect(failureView({ kind: "dropped" })).toBeUndefined();
});

test("the banner is the latest failed reply, until anyone moves on or a reply is running", () => {
	let entries = [ASK, failed("f1", { kind: "error", request: "ask" })];
	expect(failureBanner(entries, undefined, "mona")?.entry).toBe("f1");
	// A running reply is a new turn: the old failure is history.
	expect(failureBanner(entries, { id: "t2" } as Chat.Turn, "mona")).toBeUndefined();
	// A later message from a member or the agent ends it.
	expect(failureBanner([...entries, member("m2", "ada")], undefined, "mona")).toBeUndefined();
	expect(failureBanner([...entries, agent("a1")], undefined, "mona")).toBeUndefined();
	// A system notice after it does not.
	let notice: Chat.Entry = { id: "n", author: { kind: "system" }, text: "Paused.", ts: 4 };
	expect(failureBanner([...entries, notice], undefined, "mona")?.entry).toBe("f1");
	// An entry that never failed, and a dropped link, are no banner.
	expect(failureBanner([ASK, agent("a")], undefined, "mona")).toBeUndefined();
	expect(failureBanner([ASK, failed("f", { kind: "dropped", request: "ask" })], undefined, "mona"))
		.toBeUndefined();
});

test("only the person who asked can ask again; anyone else sees the failure with no button", () => {
	let entries = [ASK, failed("f1", { kind: "error", request: "ask" })];
	expect(failureBanner(entries, undefined, "mona")?.retry).toBe(true);
	expect(failureBanner(entries, undefined, "ada")?.retry).toBe(false);
});

test("a failure whose request is not in the transcript, or never had one, has nothing to ask again", () => {
	expect(
		failureBanner([failed("f1", { kind: "error", request: "gone" })], undefined, "mona")?.retry,
	)
		.toBe(false);
	expect(failureBanner([ASK, failed("f1", { kind: "error" })], undefined, "mona")?.retry).toBe(
		false,
	);
	// A message that was not addressed to the Planner is not a turn to repeat.
	let room = member("ask", "mona");
	expect(
		failureBanner([room, failed("f1", { kind: "error", request: "ask" })], undefined, "mona")
			?.retry,
	)
		.toBe(false);
});

test("Retry names the message whose turn failed, for its sender alone: the server runs that message again, so nothing new is sent", () => {
	let entries = [ASK, failed("f1", { kind: "timed-out", request: "ask", focus: "child-7" })];
	expect(failureBanner(entries, undefined, "mona")).toMatchObject({
		entry: "f1",
		request: "ask",
		retry: true,
	});
	expect(failureBanner(entries, undefined, "ada")?.request).toBeUndefined();
	// A failure asking again cannot help names nothing to run again.
	let refused = [ASK, failed("f1", { kind: "refused", request: "ask" })];
	expect(failureBanner(refused, undefined, "mona")?.request).toBeUndefined();
});

test("the failed reply's own line leaves the transcript only while the banner tells it", () => {
	let entries = [ASK, failed("f1", { kind: "error", request: "ask" })];
	expect(withoutFailure(entries, "f1").map(entry => entry.id)).toEqual(["ask"]);
	expect(withoutFailure(entries, undefined)).toBe(entries);
});

test("a refused room message is its own banner, in the server's words, and can be sent again", () => {
	let refused = sendFailureView(sendFailure(new WireRefusal("Unavailable")), undefined);
	expect(refused).toEqual({
		kind: "send",
		title: "Message not sent: Unavailable",
		retry: true,
	});
});

test("a message the machine could not take says so as the server did, and points to the machines", () => {
	let waiting = sendFailureView(
		sendFailure(
			new WireRefusal(
				"Still connecting to @mona's machine. Try again in a moment.",
				"planner-not-attached",
			),
		),
		"planner-not-attached",
	);
	expect(waiting).toEqual({
		kind: "send",
		title: "Still connecting to @mona's machine. Try again in a moment.",
		retry: false,
		link: { label: "Open machines", href: "/machines" },
	});
	let handover = sendFailureView(
		sendFailure(
			new WireRefusal(
				"Still connecting to @mona's machine, so this message wasn't sent. Send it again in a moment.",
				"planner-not-attached",
			),
		),
		"planner-not-attached",
	);
	expect(handover).toEqual({
		kind: "send",
		title:
			"Still connecting to @mona's machine, so this message wasn't sent. Send it again in a moment.",
		retry: false,
		link: { label: "Open machines", href: "/machines" },
	});
	let busy = sendFailureView(
		sendFailure(
			new WireRefusal(
				"chopin can't take messages while it works on this machine. Stop it to ask now.",
				"planner-busy",
			),
		),
		"planner-busy",
	);
	expect(busy).toEqual({
		kind: "send",
		title: "chopin can't take messages while it works on this machine. Stop it to ask now.",
		retry: false,
	});
});
