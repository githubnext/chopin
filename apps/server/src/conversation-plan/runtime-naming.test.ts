import { expect, test } from "bun:test";
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import { headingMemory } from "../chat/job-heading-memory.test-fixtures";
import { installJobCleanup, member, socket, until } from "../chat/job.test-fixtures";
import * as Jobs from "./jobs";
import { jobStream } from "../chat/job-stream.test-fixtures";
import { ActiveOwnerBindings } from "../agent/active-owner";

installJobCleanup();

test("analysis-off immediate Planner and invoked messages queue naming behind the human turn", async () => {
	for (let invoked of [false, true]) {
		let h = await headingMemory(false);
		let normal = jobStream();
		let open = h.context.openPlannerSession!;
		h.context.openPlannerSession = (owner, channel) =>
			h.plan.chat.job
				? open(owner, channel)
				: Promise.resolve({ ok: true, value: normal.session() });
		try {
			if (invoked) {
				await Chat.invoke(h.context, { id: "U_test", login: "test" }, "Authentication approach");
			} else await Chat.send(h.context, socket(), member("Authentication approach"));
			await until(() =>
				normal.prompts.length === 1 && h.plan.chat.waiting.some(item => !!item.job)
			);
			expect(h.driver.starts()).toBe(0);
			expect(h.plan.conversationPlanJobs).toHaveLength(1);
			expect(h.plan.conversationPlanJobs[0]?.trigger).toBe(h.plan.chat.entries[0]?.id);
			normal.emit("session.idle");
			await until(() => !!h.plan.chat.jobOutput);
			expect(Plan.source(h.plan)).toContain("# Authentication");
			h.driver.finish();
			await h.jobs.idle();
			expect(h.plan.conversationPlanJobs).toHaveLength(1);
			expect(h.plan.conversationPlan.queue).toEqual([]);
		} finally {
			await h.close();
		}
	}
});

test("a failed post-save admission preserves the saved send and retries on availability wake", async () => {
	let h = await headingMemory(false);
	let commit = h.opened.storage.collaboration.commit;
	let rejected = false;
	h.opened.storage.collaboration.commit = async input => {
		if (
			!rejected
			&& (input.sidecar as { conversationPlanJobs?: unknown[] }).conversationPlanJobs?.length
		) {
			rejected = true;
			throw new Error("heading admission failed");
		}
		return commit(input);
	};
	try {
		let message = { ...member("Authentication approach"), to: "room" as const };
		await Chat.send(h.context, socket(), message);
		await until(() => h.errors.length === 1);
		expect((await h.saved()).sidecar.transcript.map(entry => entry.id)).toEqual([
			message.requestId,
		]);
		expect(h.plan.conversationPlanJobs).toEqual([]);
		h.runtime.wake(h.plan);
		await until(() => !!h.plan.chat.jobOutput);
		h.driver.finish();
		await h.jobs.idle();
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("done");
	} finally {
		await h.close();
	}
});

test("saved room messages name a document with analysis off, then allow later refinement", async () => {
	let h = await headingMemory(false);
	try {
		expect(h.runtime.processor(h.plan)).toBeUndefined();
		await Chat.send(h.context, socket(), {
			...member("Choose our authentication approach."),
			to: "room",
		});
		await until(() => !!h.plan.chat.jobOutput);
		expect(Plan.source(h.plan)).toContain("# Authentication");
		h.driver.finish();
		await h.jobs.idle();
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("done");
		let later = { ...member("Now focus on offline retries."), to: "room" as const };
		await Chat.send(h.context, socket(), later);
		await until(() => h.driver.starts() === 2);
		expect(h.plan.conversationPlanJobs.at(-1)?.trigger).toBe(later.requestId);
		expect(h.plan.conversationPlan.queue).toEqual([]);
		expect(h.plan.records.size).toBe(0);
		h.driver.finish();
	} finally {
		await h.close();
	}
});

test("detached naming coalesces durably, bypasses gated analysis jobs, and wakes once attached", async () => {
	let h = await headingMemory(false);
	let attached = false;
	h.context.plannerNotAttached = async () => attached ? undefined : "Attach the Planner";
	try {
		h.plan.conversationPlanJobs = Jobs.enqueue([], {
			kind: "refine",
			target: "01K0N4X2M5R8T3VQ7YB6ZC4DEF",
			trigger: "old",
			threadId: "old-thread",
		}, new Date().toISOString());
		let first = { ...member("Authentication approach"), to: "room" as const };
		let last = { ...member("Choose our authentication approach."), to: "room" as const };
		await Chat.send(h.context, socket(), first);
		await Chat.send(h.context, socket(), last);
		await until(() => h.plan.conversationPlanJobs.some(job => job.trigger === last.requestId));
		await h.jobs.idle();
		expect(h.driver.starts()).toBe(0);
		expect(h.plan.conversationPlanJobs.map(job => job.status)).toEqual(["pending", "pending"]);
		expect((await h.saved()).sidecar.conversationPlanJobs?.at(-1)?.trigger).toBe(last.requestId);
		// Remote attachment, not the rival message sender, supplies ownership.
		await h.opened.storage.channels.claimAgentOwner(h.plan.id, h.sessionId, new Date());
		h.context.claimantSessionId = "rival";
		attached = true;
		h.runtime.wake(h.plan);
		await until(() => !!h.plan.chat.jobOutput);
		expect(h.plan.chat.owner?.sessionId).toBe(h.sessionId);
		h.driver.finish();
		await h.jobs.idle();
		expect(h.plan.conversationPlanJobs.map(job => job.status)).toEqual(["pending", "done"]);
		h.runtime.wake(h.plan);
		await h.jobs.idle();
		expect(h.driver.starts()).toBe(1);
	} finally {
		await h.close();
	}
});

test("model-off saved messages leave the authored title and analysis untouched", async () => {
	let h = await headingMemory(false, false);
	try {
		let source = Plan.source(h.plan);
		await Chat.send(h.context, socket(), { ...member("Authentication approach"), to: "room" });
		await Chat.send(h.context, socket(), member("Offline retries"));
		h.runtime.wake(h.plan);
		await h.jobs.idle();
		expect(h.driver.starts()).toBe(0);
		expect(h.plan.conversationPlanJobs).toEqual([]);
		expect(h.plan.conversationPlan.queue).toEqual([]);
		expect(Plan.source(h.plan)).toBe(source);
	} finally {
		await h.close();
	}
});

test("an implementation lock retains pending naming until the document is available", async () => {
	let h = await headingMemory(false);
	try {
		h.plan.claiming = true;
		await Chat.send(h.context, socket(), { ...member("Authentication approach"), to: "room" });
		await until(() => h.plan.conversationPlanJobs.length === 1);
		await h.jobs.idle();
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("pending");
		expect(h.driver.starts()).toBe(0);
		h.plan.claiming = false;
		h.runtime.wake(h.plan);
		await until(() => !!h.plan.chat.jobOutput);
		h.driver.finish();
		await h.jobs.idle();
		expect(h.plan.conversationPlanJobs[0]?.status).toBe("done");
	} finally {
		h.plan.claiming = false;
		await h.close();
	}
});

test("pending detached naming survives reopen and uses a newly bound authenticated context", async () => {
	let h = await headingMemory(false);
	h.context.plannerNotAttached = async () => "Attach the Planner";
	let reopened: Plan.Plan | undefined;
	let owners = new ActiveOwnerBindings(h.context.auth);
	try {
		await Chat.send(h.context, socket(), { ...member("Authentication approach"), to: "room" });
		await until(() => h.plan.conversationPlanJobs.length === 1);
		await h.jobs.idle();
		await h.close();
		reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		h.room.plan = reopened;
		h.room.closing = undefined;
		await h.runtime.attach(h.room, reopened, false);
		await h.runtime.jobs(reopened)!.idle();
		expect(h.driver.starts()).toBe(0);
		await h.opened.storage.channels.claimAgentOwner(reopened.id, h.sessionId, new Date());
		h.runtime.bind({
			...h.context,
			plan: reopened,
			chat: reopened.chat,
			claimantSessionId: "rival",
			plannerNotAttached: async () => undefined,
			activeOwner: () => owners.resolve(reopened!.id),
			persist: () => Plan.persist(reopened!),
		});
		await until(() => !!reopened!.chat.jobOutput);
		expect(reopened.chat.owner?.sessionId).toBe(h.sessionId);
		h.driver.finish();
		await h.runtime.jobs(reopened)!.idle();
		expect(reopened.conversationPlanJobs[0]?.status).toBe("done");
		expect(h.driver.starts()).toBe(1);
		h.runtime.wake(reopened);
		await h.runtime.jobs(reopened)!.idle();
		expect(h.driver.starts()).toBe(1);
	} finally {
		owners.revokeAll();
		if (reopened) {
			await h.runtime.stop(reopened);
			await Plan.close(reopened);
		}
		await h.close();
	}
});
