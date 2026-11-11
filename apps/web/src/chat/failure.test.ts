import { expect, test } from "bun:test";

import { INTERNAL_IN_STATUS } from "@chopin/protocol/plain-words";

import {
	failureBanner,
	failureView,
	retryPayload,
	sendFailureView,
	withoutFailure,
} from "./failure";
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

test("asking again repeats the same turn: its text, its references, its destination and the document it was about", () => {
	let referenced = member("ask", "mona", {
		to: "planner",
		text: "Compare with the plan",
		references: [
			{
				id: "r1",
				kind: "document",
				channelId: "ch-1",
				start: 13,
				end: 22,
				label: "The plan",
				href: "/x",
				repositoryId: "R1",
				observedRevision: 3,
				observedSourceHash: "sha256:a",
			},
			{
				id: "r2",
				kind: "research",
				workspaceId: "w-1",
				parentChannelId: "ch-0",
				start: 0,
				end: 7,
				label: "Compare",
				href: "/y",
				repositoryId: "R1",
				observedRevision: 1,
			},
		],
	});
	let entries = [referenced, failed("f1", { kind: "timed-out", request: "ask", focus: "child-7" })];
	let payload = retryPayload(entries, "f1", () => "req-new");
	expect(payload).toEqual({
		requestId: "req-new",
		text: "Compare with the plan",
		to: "planner",
		references: [
			{ kind: "document", channelId: "ch-1", start: 13, end: 22 },
			{ kind: "research", workspaceId: "w-1", start: 0, end: 7 },
		],
		focus: "child-7",
	});
	// Nothing is added that the original did not have.
	let bare = [ASK, failed("f2", { kind: "error", request: "ask" })];
	expect(retryPayload(bare, "f2", () => "req-2")).toEqual({
		requestId: "req-2",
		text: "from ask",
		to: "planner",
	});
});

test("asking again repeats a command as the command it was, with its kind", () => {
	let ran = member("ask", "mona", {
		to: "planner",
		text: "/review the diff",
		references: [{
			id: "c1",
			kind: "command",
			start: 0,
			end: 7,
			label: "/review",
			name: "review",
			commandKind: "prompt",
		}],
	});
	let payload = retryPayload(
		[ran, failed("f1", { kind: "error", request: "ask" })],
		"f1",
		() => "r",
	);
	expect(payload).toEqual({
		requestId: "r",
		text: "/review the diff",
		to: "planner",
		references: [{ kind: "command", name: "review", commandKind: "prompt", start: 0, end: 7 }],
	});
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
});
