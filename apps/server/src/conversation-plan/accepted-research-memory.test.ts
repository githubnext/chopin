import { expect, spyOn, test } from "bun:test";
import * as Plan from "../plan/service";
import { acceptedResearchMemory } from "./accepted-research.test-fixtures";

test("commits frozen human consent, request, reference and marker before enqueue", async () => {
	let h = await acceptedResearchMemory();
	let enqueue = h.opened.storage.jobs.enqueue;
	let observations: string[] = [];
	let watch = spyOn(h.opened.storage.jobs, "enqueue").mockImplementation(async input => {
		let saved = await h.opened.storage.collaboration.load(h.plan.id, new Date());
		let restored = await Plan.readStored(saved!);
		expect(JSON.stringify(saved!.sidecar)).toContain('"principalId":"U_test"');
		expect(JSON.stringify(saved!.sidecar)).toContain('"status":"accepted"');
		let offer = h.plan.conversationPlan.researchOffers![0]!;
		let link = await h.research.acceptedOfferLink(h.plan.id, offer);
		let detail = await h.opened.storage.research.get(h.plan.id, link.researchRequestId!);
		expect(restored.source).toContain(`<Research id="${detail!.workspace.id}" />`);
		expect(detail!.workspace).toMatchObject({ inlineReference: "placed", createdBy: "U_test" });
		expect(detail!.turns[0]).toMatchObject({ requestedBy: "U_test", evidenceJobId: undefined });
		expect(detail!.messages[0]).toMatchObject({ userId: "U_test", userHandle: "test" });
		expect(offer.action).toMatchObject({
			principalId: "U_test",
			actor: { kind: "member", handle: "test" },
		});
		observations.push(input.type);
		return enqueue(input);
	});
	try {
		let response = await h.consent();
		expect(response).toMatchObject({ kind: "conversation-plan:research", execution: "started" });
		expect(observations).toEqual(["research-evidence"]);
		expect(await h.link()).toMatchObject({
			status: "linked",
			researchRequestId: response.researchRequestId,
		});
		let jobs = await h.researchJobs.list(h.plan.id, 100);
		let before = h.opened.broadcasts.length;
		expect(await h.consent()).toMatchObject({ execution: "started" });
		expect(await h.link()).toMatchObject({ status: "linked" });
		expect(await h.researchJobs.list(h.plan.id, 100)).toEqual(jobs);
		expect(h.opened.broadcasts.length).toBe(before);
		expect(h.plan.conversationPlanEffects).toContain(`research:${h.offerId}`);
		let raw = await h.opened.storage.collaboration.load(h.plan.id, new Date());
		expect(JSON.stringify(raw!.sidecar)).toContain('"principalId":"U_test"');
		expect(h.errors).toEqual([]);
	} finally {
		watch.mockRestore();
		await h.close();
	}
});

test("revoked authenticated owner leaves consent and placed request pending without enqueue", async () => {
	let h = await acceptedResearchMemory();
	h.afterPlace(async () => {
		await h.revokeSession();
	});
	try {
		expect(await h.consent()).toMatchObject({ execution: "pending-owner", status: "accepted" });
		expect(await h.link()).toMatchObject({ status: "unlinked" });
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		expect(h.plan.conversationPlanPendingEffects).toContainEqual({
			key: `research:${h.offerId}`,
			kind: "research",
			offerId: h.offerId,
		});
		expect(h.plan.conversationPlanEffects).not.toContain(`research:${h.offerId}`);
		let offer = h.plan.conversationPlan.researchOffers![0]!;
		let action = structuredClone(offer.action);
		await h.member("U_other", "another-member");
		expect(await h.resume()).toMatchObject({ execution: "pending-owner" });
		expect(h.plan.conversationPlan.researchOffers![0]!.action).toEqual(action);
		expect(await h.link()).toMatchObject({ status: "unlinked" });
		expect((await h.researchJobs.list(h.plan.id, 100))?.jobs).toEqual([]);
		let raw = await h.opened.storage.collaboration.load(h.plan.id, new Date());
		expect(JSON.stringify(raw!.sidecar)).toContain('"principalId":"U_test"');
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
});
