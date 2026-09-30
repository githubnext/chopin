import { installJobCleanup } from "./job.test-fixtures";
import { expect, spyOn, test } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import { headingMemory } from "./job-heading-memory.test-fixtures";
import { socket, until } from "./job.test-fixtures";

installJobCleanup();

async function suspendHeading() {
	let h = await headingMemory();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let restore = Room.restore;
	let held = spyOn(Room, "restore").mockImplementation(async (...args) => {
		let document = await restore(...args);
		entered.resolve();
		await release.promise;
		return document;
	});
	await Chat.send(h.context, socket(), {
		kind: "chat:send",
		rid: "send",
		requestId: crypto.randomUUID(),
		to: "room",
		text: "Choose our authentication approach.",
		ts: 0,
	});
	await entered.promise;
	return { h, release, held };
}

test("closing a held actual heading tool fences late document publication and restores interrupted work", async () => {
	let { h, release, held } = await suspendHeading();
	try {
		expect(h.plan.chat.job?.kind).toBe("heading");
		let closing = h.close();
		expect(h.plan.chat.job).toBeUndefined();
		release.resolve();
		await closing;
		held.mockRestore();
		let saved = await h.saved();
		expect(saved.source.trim()).toBe("");
		expect(saved.sidecar.transcript).toHaveLength(1);
		expect(h.opened.broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened).trim()).toBe("");
			expect(reopened.conversationPlanJobs).toMatchObject([{
				status: "failed",
				reason: "interrupted",
			}]);
			expect(reopened.chat.waiting).toEqual([]);
			expect(h.driver.starts()).toBe(1);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		release.resolve();
		held.mockRestore();
		await h.close();
	}
});

test("credential reset invalidates a held actual heading tool before its staged mutation can commit", async () => {
	let { h, release, held } = await suspendHeading();
	try {
		await Chat.resetAgent(h.plan.chat, h.sessionId, 1, "Planner credentials were revoked.");
		expect(h.plan.chat.job).toBeUndefined();
		release.resolve();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "failed");
		await h.jobs.idle();
		await Plan.exclusive(h.plan, async () => {});
		held.mockRestore();
		let saved = await h.saved();
		expect(saved.source.trim()).toBe("");
		expect(saved.sidecar.conversationPlanJobs).toMatchObject([{
			status: "failed",
			reason: "Planner credentials were revoked.",
		}]);
		expect(saved.sidecar.transcript).toHaveLength(1);
		expect(h.plan.chat.jobOutput).toBeUndefined();
		expect(h.opened.broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened).trim()).toBe("");
			expect(reopened.conversationPlanJobs[0]?.status).toBe("failed");
			expect(h.driver.starts()).toBe(1);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		release.resolve();
		held.mockRestore();
		await h.close();
	}
});

test("active owner revocation fences a held actual heading tool without a Chat reset", async () => {
	let { h, release, held } = await suspendHeading();
	try {
		h.invalidateOwner();
		expect(h.plan.chat.job).toBeUndefined();
		release.resolve();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "failed");
		await h.jobs.idle();
		await Plan.exclusive(h.plan, async () => {});
		held.mockRestore();
		let saved = await h.saved();
		expect(saved.source.trim()).toBe("");
		expect(saved.sidecar.conversationPlanJobs).toMatchObject([{
			status: "failed",
			reason: "credential-rotated",
		}]);
		expect(saved.sidecar.transcript).toHaveLength(1);
		expect(h.plan.chat.jobOutput).toBeUndefined();
		expect(h.opened.broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened).trim()).toBe("");
			expect(reopened.conversationPlanJobs[0]?.status).toBe("failed");
			expect(h.driver.starts()).toBe(1);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		release.resolve();
		held.mockRestore();
		await h.close();
	}
});
