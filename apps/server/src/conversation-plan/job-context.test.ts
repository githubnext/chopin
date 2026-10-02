import { expect, test } from "bun:test";

import type * as Chat from "../chat/service";
import type { Job } from "./jobs";
import { createJobContexts } from "./job-context";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import { effectsFor } from "./effects";

function plan(owner?: string): Parameters<ReturnType<typeof createJobContexts>["remember"]>[0] {
	return {
		chat: { owner: owner ? { sessionId: owner } : undefined },
		conversationPlan: initialState(),
		conversationPlanJobs: [],
		conversationPlanPendingEffects: [],
		pendingCardActions: [],
		persistence: { committedSidecar: {} },
	};
}

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
	let opened = plan();
	opened.conversationPlanJobs = [job("m0")];
	let original = context("original-session");
	contexts.remember(opened, "m0", original);
	for (let index = 1; index <= 80; index++) {
		contexts.remember(opened, `m${index}`, context(`other-${index}`));
	}
	expect(contexts.claim(opened, job("m0"))).toEqual({
		context: original,
		claimantSessionId: "original-session",
	});
	expect(contexts.claim(opened, job("missing"))).toBeUndefined();
});

test("a failed accept removes only its own captured context", () => {
	let contexts = createJobContexts();
	let opened = plan();
	opened.conversationPlanJobs = [job("old-message")];
	let old = context("old");
	let failed = context("failed");
	contexts.remember(opened, "old-message", old);
	contexts.remember(opened, "new-message", failed);
	contexts.forget(opened, "new-message", failed);
	expect(contexts.claim(opened, job("new-message"))).toBeUndefined();
	expect(contexts.claim(opened, job("old-message"))?.context).toBe(old);
	let replacement = context("replacement");
	let prior = contexts.remember(opened, "old-message", replacement);
	contexts.forget(opened, "old-message", old);
	expect(contexts.claim(opened, job("old-message"))?.context).toBe(replacement);
	contexts.restore(opened, "old-message", replacement, prior);
	expect(contexts.claim(opened, job("old-message"))?.context).toBe(old);
});

test("a duplicate-ID accept failure restores the first accepted claimant", async () => {
	let contexts = createJobContexts();
	let opened = plan();
	let accepted = context("accepted-session");
	let duplicate = context("duplicate-session");
	await contexts.accept(opened, "same-message", accepted, async () => {
		opened.conversationPlanJobs = [job("same-message")];
	});
	await expect(contexts.accept(opened, "same-message", duplicate, async () => {
		throw new Error("duplicate message");
	})).rejects.toThrow("duplicate message");
	expect(contexts.claim(opened, job("same-message"))).toEqual({
		context: accepted,
		claimantSessionId: "accepted-session",
	});
});

test("current owner wins credentials without borrowing a later member's session", () => {
	let contexts = createJobContexts();
	let opened = plan("owner");
	opened.conversationPlanJobs = [job("m1")];
	let original = context("original");
	contexts.remember(opened, "m1", original);
	contexts.remember(opened, "m2", context("later"));
	expect(contexts.claim(opened, job("m1"))).toEqual({
		context: original,
		claimantSessionId: "owner",
	});
	expect(contexts.claim(opened, job("missing"))).toBeUndefined();
	let owner = context("owner");
	contexts.remember(opened, "owner-message", owner);
	expect(contexts.claim(opened, job("missing"))).toEqual({
		context: owner,
		claimantSessionId: "owner",
	});
});

test("a prose job requires its winning Save claimant even when another owner context exists", () => {
	let contexts = createJobContexts();
	let opened = plan("owner");
	contexts.remember(opened, "old-message", context("owner"));
	let prose: Job = {
		...job("decided:W1:2"),
		id: "prose:W1:decided:W1:2",
		kind: "prose",
	};
	expect(contexts.claim(opened, prose)).toBeUndefined();
	opened.conversationPlanJobs = [prose];
	let saver = context("save-session");
	contexts.remember(opened, prose.trigger, saver);
	expect(contexts.claim(opened, prose)).toEqual({
		context: saver,
		claimantSessionId: "owner",
	});
});

test("accepted messages without unfinished work release their original job contexts", async () => {
	let contexts = createJobContexts();
	let opened = plan();
	for (let index = 0; index < 1000; index++) {
		await contexts.accept(opened, `m${index}`, context(`member-${index}`), async () => {});
	}
	expect(contexts.claim(opened, job("m0"))).toBeUndefined();
	expect(contexts.claim(opened, job("m998"))).toBeUndefined();
	expect(contexts.any(opened)?.claimantSessionId).toBe("member-999");
});

test("completed and skipped jobs release contexts while retryable jobs retain them", () => {
	for (let status of ["pending", "running", "failed", "done", "skipped"] as const) {
		let contexts = createJobContexts();
		let opened = plan();
		opened.conversationPlanJobs = [{ ...job("original"), status }];
		let original = context("original-member");
		contexts.remember(opened, "original", original);
		for (let index = 0; index < 80; index++) {
			contexts.remember(opened, `later-${index}`, context("later"));
		}
		expect(contexts.claim(opened, job("original"))?.context).toBe(
			status === "done" || status === "skipped" ? undefined : original,
		);
		opened.conversationPlanJobs = [];
		expect(contexts.claim(opened, job("original"))).toBeUndefined();
	}
});

test("queued and failed analysis retain their member until the queue entry is consumed", () => {
	for (let status of ["pending", "processing", "failed"] as const) {
		let contexts = createJobContexts();
		let opened = plan();
		opened.conversationPlan.queue = [{ messageId: "original", status, attempts: 1 }];
		let original = context("original-member");
		contexts.remember(opened, "original", original);
		contexts.remember(opened, "later", context("later"));
		expect(contexts.claim(opened, job("original"))?.context).toBe(original);
		opened.conversationPlan.queue = [];
		expect(contexts.claim(opened, job("original"))).toBeUndefined();
	}
});

test("winning Save context survives the pending action and job-effect handover", () => {
	let contexts = createJobContexts();
	let opened = plan("owner");
	let trigger = "decided:W1:2";
	let prose: Job = { ...job(trigger), kind: "prose" };
	let saver = context("saver");
	opened.pendingCardActions = [{
		id: "card:W1:decided:2",
		kind: "decided",
		cardId: "W1",
		threadId: "t1",
		actor: "saver",
		at: 1,
		generation: 2,
		optionIds: [],
		text: "Use Alpha",
	}];
	contexts.remember(opened, trigger, saver);
	contexts.remember(opened, "owner", context("owner"));
	expect(contexts.claim(opened, prose)?.context).toBe(saver);
	opened.pendingCardActions = [];
	opened.conversationPlanPendingEffects = [{
		key: "prose-effect",
		kind: "job",
		threadId: "t1",
		intent: { kind: "prose", target: "W1", trigger },
	}];
	contexts.remember(opened, "later", context("later"));
	expect(contexts.claim(opened, prose)?.context).toBe(saver);
	opened.conversationPlanPendingEffects = [];
	opened.conversationPlanJobs = [prose];
	expect(contexts.claim(opened, prose)?.context).toBe(saver);
	opened.conversationPlanJobs = [{ ...prose, status: "done" }];
	expect(contexts.claim(opened, prose)).toBeUndefined();
});

test("the current owner fallback survives later members and replaces older owner contexts", () => {
	let contexts = createJobContexts();
	let opened = plan("owner");
	contexts.remember(opened, "old-owner", context("owner"));
	let current = context("owner");
	contexts.remember(opened, "current-owner", current);
	contexts.remember(opened, "later-member", context("later"));
	expect(contexts.claim(opened, job("missing"))?.context).toBe(current);
	opened.chat.owner = undefined;
	expect(contexts.claim(opened, job("current-owner"))).toBeUndefined();
	expect(contexts.any(opened)?.claimantSessionId).toBe("later");
});

test("acceptance retains its claimant while another message commits before its queue entry", async () => {
	let contexts = createJobContexts();
	let opened = plan();
	let original = context("original");
	let release!: () => void;
	let waiting = new Promise<void>(resolve => {
		release = resolve;
	});
	let accepting = contexts.accept(opened, "first", original, async () => {
		await waiting;
		opened.conversationPlan.queue = [{ messageId: "first", status: "pending", attempts: 0 }];
	});
	await contexts.accept(opened, "second", context("second"), async () => {});
	expect(contexts.claim(opened, job("first"))?.context).toBe(original);
	release();
	await accepting;
	expect(contexts.claim(opened, job("first"))?.context).toBe(original);
	opened.conversationPlan.queue = [];
	expect(contexts.claim(opened, job("first"))).toBeUndefined();
});

test("pruning preserves committed roots while a removal is staged and can roll back", () => {
	for (let root of ["analysis", "job", "effect"] as const) {
		let contexts = createJobContexts();
		let opened = plan();
		if (root === "analysis") {
			opened.conversationPlan.queue = [{
				messageId: "original",
				status: "processing",
				attempts: 1,
			}];
		} else if (root === "job") {
			opened.conversationPlanJobs = [job("original")];
		} else {
			opened.conversationPlanPendingEffects = [{
				key: "refine-effect",
				kind: "job",
				intent: { kind: "refine", target: "W1", trigger: "original" },
			}];
		}
		let committed = {
			conversationPlan: opened.conversationPlan,
			conversationPlanJobs: opened.conversationPlanJobs,
			conversationPlanPendingEffects: opened.conversationPlanPendingEffects,
			pendingCardActions: [],
		};
		opened.persistence.committedSidecar = JSON.parse(JSON.stringify(committed));
		let original = context("original");
		contexts.remember(opened, "original", original);
		opened.conversationPlan = initialState();
		opened.conversationPlanJobs = [];
		opened.conversationPlanPendingEffects = [];
		contexts.remember(opened, "later", context("later"));
		Object.assign(opened, committed);
		expect(contexts.claim(opened, job("original"))?.context).toBe(original);
		opened.conversationPlan = initialState();
		opened.conversationPlanJobs = [];
		opened.conversationPlanPendingEffects = [];
		opened.persistence.committedSidecar = {};
		expect(contexts.claim(opened, job("original"))).toBeUndefined();
	}
});

test("card insertion keeps the original question claimant until linking creates its refine effect", () => {
	let contexts = createJobContexts();
	let opened = plan();
	let source = {
		messageId: "question-message",
		author: { kind: "member", handle: "alice" } as const,
		quote: "Which editor?",
		start: 0,
		end: 13,
		role: "question" as const,
	};
	let event = {
		id: "opened-event",
		type: "thread.opened" as const,
		threadId: "t1",
		observedThreadVersion: 0,
		origin: "classifier" as const,
		actor: { kind: "classifier" } as const,
		at: 1,
		question: source.quote,
		source,
	};
	opened.conversationPlan = applyEvent(opened.conversationPlan, event);
	opened.conversationPlanPendingEffects = effectsFor([event], opened.conversationPlan);
	let original = context("question-author");
	contexts.remember(opened, source.messageId, original);
	contexts.remember(opened, "later", context("later"));
	expect(contexts.claim(opened, job(source.messageId))?.context).toBe(original);
	let linked = {
		id: "linked-event",
		type: "card.linked" as const,
		threadId: "t1",
		observedThreadVersion: 1,
		origin: "classifier" as const,
		actor: { kind: "classifier" } as const,
		at: 2,
		questionnaireId: "W1",
	};
	opened.conversationPlan = applyEvent(opened.conversationPlan, linked);
	opened.conversationPlanPendingEffects = effectsFor([linked], opened.conversationPlan);
	expect(contexts.claim(opened, job(source.messageId))?.context).toBe(original);
	opened.conversationPlanPendingEffects = [];
	expect(contexts.claim(opened, job(source.messageId))).toBeUndefined();
});
