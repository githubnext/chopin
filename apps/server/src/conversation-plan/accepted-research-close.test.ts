import { expect, spyOn, test } from "bun:test";
import * as Plan from "../plan/service";
import { acceptedResearchMemory } from "./accepted-research.test-fixtures";

test("stop and idle drain admitted research consent through its durable receipt before close", async () => {
	let h = await acceptedResearchMemory();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let originalStart = h.deps.start;
	h.deps.start = async (...args) => {
		let result = await originalStart(...args);
		entered.resolve();
		await release.promise;
		return result;
	};
	let closed = false;
	let commitsAfterClose = 0;
	let originalCommit = h.opened.storage.collaboration.commit;
	let commit = spyOn(h.opened.storage.collaboration, "commit").mockImplementation(async input => {
		if (closed) commitsAfterClose++;
		return originalCommit(input);
	});
	let consent = h.consent();
	let closing: Promise<void> | undefined;
	try {
		await entered.promise;
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toHaveLength(1);
		expect(Plan.source(h.plan)).toContain("<Research");
		expect(h.plan.conversationPlanEffects).not.toContain(`research:${h.offerId}`);
		let idleResolved = false;
		let closeCalled = false;
		let receiptBeforeClose = false;
		let stopped = h.runtime.stop(h.plan);
		let idle = h.processor.idle();
		closing = Promise.all([stopped, idle]).then(async () => {
			idleResolved = true;
			let saved = await h.opened.storage.collaboration.load(h.plan.id, new Date());
			let sidecar = saved?.sidecar;
			if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
				let receipts = sidecar.conversationPlanEffects;
				let pending = sidecar.conversationPlanPendingEffects;
				receiptBeforeClose = Array.isArray(receipts) && receipts.includes(`research:${h.offerId}`)
					&& (pending === undefined || Array.isArray(pending) && pending.length === 0);
			}
			closeCalled = true;
			await Plan.close(h.plan);
			closed = true;
		});
		await Bun.sleep(10);
		expect(idleResolved).toBe(false);
		expect(closeCalled).toBe(false);
		expect(h.plan.persistence.closing).toBe(false);
		release.resolve();
		expect(await consent).toMatchObject({ execution: "started" });
		await closing;
		expect(idleResolved).toBe(true);
		expect(receiptBeforeClose).toBe(true);
		expect(commitsAfterClose).toBe(0);
		commit.mockRestore();
		let reopened = await Plan.open(h.plan.id, h.opened.backend, h.opened.server);
		try {
			expect(reopened.conversationPlanPendingEffects).toEqual([]);
			expect(reopened.conversationPlanEffects).toContain(`research:${h.offerId}`);
			expect(Plan.source(reopened)).toContain("<Research");
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		release.resolve();
		await consent;
		await closing;
		commit.mockRestore();
		h.revokeAll();
		if (!closed) await h.close();
	}
});
