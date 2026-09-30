import { expect, test } from "bun:test";

import type * as Chat from "../chat/service";
import type { Job } from "./jobs";
import { createJobContexts } from "./job-context";

function context(sessionId: string): Chat.Room {
	return { claimantSessionId: sessionId } as Chat.Room;
}

function job(trigger: string): Job {
	return {
		id: `refine:W1:${trigger}`,
		kind: "refine",
		target: "W1",
		trigger,
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

test("a job claims its original member after more than 64 later messages", () => {
	let contexts = createJobContexts();
	let plan = { chat: { owner: undefined } };
	let original = context("original-session");
	contexts.remember(plan, "m0", original);
	for (let index = 1; index <= 80; index++) {
		contexts.remember(plan, `m${index}`, context(`other-${index}`));
	}
	expect(contexts.claim(plan, job("m0"))).toEqual({
		context: original,
		claimantSessionId: "original-session",
	});
	expect(contexts.claim(plan, job("missing"))).toBeUndefined();
});

test("a failed accept removes only its own captured context", () => {
	let contexts = createJobContexts();
	let plan = { chat: { owner: undefined } };
	let old = context("old");
	let failed = context("failed");
	contexts.remember(plan, "old-message", old);
	contexts.remember(plan, "new-message", failed);
	contexts.forget(plan, "new-message", failed);
	expect(contexts.claim(plan, job("new-message"))).toBeUndefined();
	expect(contexts.claim(plan, job("old-message"))?.context).toBe(old);
	let replacement = context("replacement");
	let prior = contexts.remember(plan, "old-message", replacement);
	contexts.forget(plan, "old-message", old);
	expect(contexts.claim(plan, job("old-message"))?.context).toBe(replacement);
	contexts.restore(plan, "old-message", replacement, prior);
	expect(contexts.claim(plan, job("old-message"))?.context).toBe(old);
});

test("a duplicate-ID accept failure restores the first accepted claimant", async () => {
	let contexts = createJobContexts();
	let plan = { chat: { owner: undefined } };
	let accepted = context("accepted-session");
	let duplicate = context("duplicate-session");
	await contexts.accept(plan, "same-message", accepted, async () => {});
	await expect(contexts.accept(plan, "same-message", duplicate, async () => {
		throw new Error("duplicate message");
	})).rejects.toThrow("duplicate message");
	expect(contexts.claim(plan, job("same-message"))).toEqual({
		context: accepted,
		claimantSessionId: "accepted-session",
	});
});

test("current owner wins credentials without borrowing a later member's session", () => {
	let contexts = createJobContexts();
	let plan = { chat: { owner: { sessionId: "owner" } } };
	let original = context("original");
	contexts.remember(plan, "m1", original);
	contexts.remember(plan, "m2", context("later"));
	expect(contexts.claim(plan, job("m1"))).toEqual({
		context: original,
		claimantSessionId: "owner",
	});
	expect(contexts.claim(plan, job("missing"))).toBeUndefined();
	let owner = context("owner");
	contexts.remember(plan, "owner-message", owner);
	expect(contexts.claim(plan, job("missing"))).toEqual({
		context: owner,
		claimantSessionId: "owner",
	});
});

test("a prose job requires its winning Save claimant even when another owner context exists", () => {
	let contexts = createJobContexts();
	let plan = { chat: { owner: { sessionId: "owner" } } };
	contexts.remember(plan, "old-message", context("owner"));
	let prose: Job = {
		...job("decided:W1:2"),
		id: "prose:W1:decided:W1:2",
		kind: "prose",
	};
	expect(contexts.claim(plan, prose)).toBeUndefined();
	let saver = context("save-session");
	contexts.remember(plan, prose.trigger, saver);
	expect(contexts.claim(plan, prose)).toEqual({
		context: saver,
		claimantSessionId: "owner",
	});
});
