import { expect, spyOn, test } from "bun:test";
import * as Draft from "@chopin/draft";
import * as Plan from "../plan/service";
import { acceptedResearchMemory } from "./accepted-research.test-fixtures";

async function generalOffer() {
	let h = await acceptedResearchMemory();
	await Plan.exclusive(h.plan, async () => {
		let offer = h.plan.conversationPlan.researchOffers![0]!;
		offer.workflow = {
			version: 1,
			revision: 0,
			generation: 0,
			generationBrief: offer.brief,
			mode: "automatic",
			placementMessageId: offer.source.messageId,
			sources: [offer.source],
			context: { messages: [], decisions: [] },
			published: true,
			preparation: "ready",
			editedBy: [],
			additions: [],
		};
		await Plan.persistExclusive(h.plan);
	});
	return h;
}

test("Start seals the latest shared draft and delivers one stable offer-scoped request", async () => {
	let h = await generalOffer();
	try {
		let processor = h.runtime.processor(h.plan)!;
		let actor = { kind: "member" as const, handle: "test" };
		let opened = await processor.editResearch(h.offerId, { kind: "begin" }, actor);
		let model = Draft.restore(opened.offer.workflow!.draft!).fork();
		let brief = "Compare external API documentation and published limitations.";
		await processor.editResearch(
			h.offerId,
			{ kind: "patch", patch: Draft.change(model, brief)! },
			actor,
		);
		let replies = await Promise.all([h.consent(), h.consent()]);
		expect(replies.every(reply => (reply as { execution?: string }).execution === "started")).toBe(
			true,
		);
		let offer = h.plan.conversationPlan.researchOffers![0]!;
		expect(offer.workflow!.accepted).toMatchObject({
			brief,
			executionKey: offer.id,
			revision: offer.workflow!.revision,
		});
		let link = await h.research.acceptedOfferLink(h.plan.id, offer);
		expect(link.status).toBe("linked");
		let request = await h.research.request(h.plan.id, link.researchRequestId!);
		expect(request!.question).toBe(brief);
		expect((await h.researchJobs.list(h.plan.id, 100))!.jobs).toHaveLength(1);
		let late = await processor.editResearch(h.offerId, {
			kind: "patch",
			patch: Draft.change(model, "Late edit")!,
		}, actor);
		expect(late.offer.brief).toBe(brief);
	} finally {
		await h.close();
	}
});

test("failed acceptance persistence retains the editable draft and creates no request", async () => {
	let h = await generalOffer();
	let before = structuredClone(h.plan.conversationPlan.researchOffers![0]!);
	let original = h.opened.storage.collaboration.commit;
	let fail = true;
	let commit = spyOn(h.opened.storage.collaboration, "commit").mockImplementation(input => {
		if (fail) {
			fail = false;
			throw new Error("acceptance failed");
		}
		return original(input);
	});
	try {
		await h.consent();
		expect(h.plan.conversationPlan.researchOffers![0]).toEqual(before);
		expect((await h.researchJobs.list(h.plan.id, 100))!.jobs).toEqual([]);
		expect(await h.consent()).toMatchObject({ status: "accepted", execution: "started" });
	} finally {
		commit.mockRestore();
		await h.close();
	}
});

test("moving the offer presentation never changes request identity", async () => {
	let h = await generalOffer();
	try {
		await Plan.exclusive(h.plan, async () => {
			let offer = h.plan.conversationPlan.researchOffers![0]!;
			let text = "Please include current published limits.";
			h.plan.chat.entries.push({ id: "later-source", author: offer.source.author, text, ts: 20 });
			offer.workflow!.sources.push({
				messageId: "later-source",
				author: offer.source.author,
				quote: text,
				start: 0,
				end: text.length,
			});
			offer.workflow!.placementMessageId = "later-source";
			await Plan.persistExclusive(h.plan);
		});
		expect(await h.consent()).toMatchObject({ execution: "started" });
		let first = await h.link();
		expect(await h.resume()).toMatchObject({ execution: "started" });
		expect(await h.link()).toMatchObject({
			researchRequestId: (first as { researchRequestId: string }).researchRequestId,
		});
	} finally {
		await h.close();
	}
});
