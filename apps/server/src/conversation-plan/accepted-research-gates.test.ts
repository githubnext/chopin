import { expect, spyOn, test } from "bun:test";
import * as Plan from "../plan/service";
import { acceptedResearchMemory } from "./accepted-research.test-fixtures";

for (let gate of ["viewer", "archived", "closing", "unavailable"] as const) {
	test(`refuses research consent through the ${gate} write gate`, async () => {
		let h = await acceptedResearchMemory();
		try {
			if (gate === "viewer") h.ws.data.canEdit = false;
			if (gate === "archived") {
				await h.opened.storage.channels.archive({ id: h.plan.id, now: new Date() });
				h.ws.data.channelArchivedAt = new Date().toISOString();
			}
			if (gate === "closing") h.room.closing = Promise.resolve();
			if (gate === "unavailable") h.setUnavailable(true);
			expect(await h.consent()).toMatchObject({ kind: "session:error" });
			expect(h.plan.conversationPlan.researchOffers![0]!.status).toBe("offered");
			expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
			expect(await h.opened.storage.research.list(h.plan.id, 100)).toEqual([]);
			expect(Plan.source(h.plan)).not.toContain("<Research");
		} finally {
			await h.close();
		}
	});
}

test("lookup rechecks access and never resumes accepted work", async () => {
	let h = await acceptedResearchMemory();
	try {
		let pending = await h.processor.researchConsent(
			{ offerId: h.offerId, choice: "research", actionId: "human-consent" },
			{ kind: "member", handle: "test" },
			"U_test",
		);
		expect(pending.execution).toBe("pending-retry");
		expect(await h.link()).toMatchObject({ status: "pending" });
		expect(await h.link()).toMatchObject({ status: "pending" });
		h.setAccess("unavailable");
		expect(await h.link()).toMatchObject({
			kind: "session:error",
			message: "authorization is temporarily unavailable",
		});
		expect(h.closes).toEqual([]);
		h.setAccess("denied");
		expect(await h.link()).toMatchObject({
			kind: "session:error",
			message: "authorization expired",
		});
		expect(h.closes).toEqual([4403]);
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		expect(await h.opened.storage.research.list(h.plan.id, 100)).toEqual([]);
		expect(Plan.source(h.plan)).not.toContain("<Research");
	} finally {
		await h.close();
	}
});

test("live repository denial after accepted consent cannot claim or enqueue research", async () => {
	let h = await acceptedResearchMemory();
	let repository = h.context.repository;
	let access = spyOn(h.context.auth.github, "repositoryAccess").mockResolvedValue({
		...repository,
		fullName: "owner/repository",
		private: false,
		url: "https://github.com/owner/repository",
		permissions: { pull: true, push: false, admin: false },
	});
	try {
		expect(await h.consent()).toMatchObject({ execution: "pending-owner", status: "accepted" });
		expect(await h.link()).toMatchObject({ status: "pending" });
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		expect(await h.opened.storage.research.list(h.plan.id, 100)).toEqual([]);
		expect(Plan.source(h.plan)).not.toContain("<Research");
		expect(h.plan.conversationPlanEffects).not.toContain(`research:${h.offerId}`);
	} finally {
		access.mockRestore();
		await h.close();
	}
});
