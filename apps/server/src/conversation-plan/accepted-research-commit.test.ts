import { expect, spyOn, test } from "bun:test";
import * as Plan from "../plan/service";
import { acceptedResearchMemory } from "./accepted-research.test-fixtures";

test("holds enqueue and live reference behind the actual fenced document commit", async () => {
	let h = await acceptedResearchMemory();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let original = h.opened.storage.collaboration.commit;
	let commit = spyOn(h.opened.storage.collaboration, "commit").mockImplementation(async input => {
		if (input.update) {
			entered.resolve();
			await release.promise;
		}
		return original(input);
	});
	let consent = h.consent();
	try {
		await entered.promise;
		let saved = await h.opened.storage.collaboration.load(h.plan.id, new Date());
		expect(JSON.stringify(saved!.sidecar)).toContain('"status":"accepted"');
		expect((await Plan.readStored(saved!)).source).not.toContain("<Research");
		expect(Plan.source(h.plan)).not.toContain("<Research");
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		expect(h.frames).toEqual([]);
		release.resolve();
		expect(await consent).toMatchObject({ execution: "started" });
		expect(Plan.source(h.plan)).toContain("<Research");
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toHaveLength(1);
	} finally {
		release.resolve();
		await consent;
		commit.mockRestore();
		await h.close();
	}
});

test("failed reference commit retains accepted delivery without publishing or enqueue", async () => {
	let h = await acceptedResearchMemory();
	let original = h.opened.storage.collaboration.commit;
	let commit = spyOn(h.opened.storage.collaboration, "commit").mockImplementation(async input => {
		if (input.update) throw new Error("reference commit rejected");
		return original(input);
	});
	try {
		expect(await h.consent()).toMatchObject({ status: "accepted", execution: "pending-retry" });
		expect(Plan.source(h.plan)).not.toContain("<Research");
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		let [pending] = await h.opened.storage.research.listReferenceRecovery(
			100,
			undefined,
			h.plan.id,
		);
		expect(pending?.inlineReference).toBe("pending");
		expect(await h.link()).toMatchObject({ status: "unlinked", researchRequestId: pending!.id });
		expect(h.plan.conversationPlanEffects).not.toContain(`research:${h.offerId}`);
		expect(h.opened.broadcasts.filter(frame => frame.kind === "plan:update")).toEqual([]);
		expect(h.errors).toHaveLength(1);
	} finally {
		commit.mockRestore();
		await h.close();
	}
});
