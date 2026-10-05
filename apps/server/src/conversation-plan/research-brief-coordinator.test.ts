import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { applyResearchOpportunity } from "./research-opportunities";
import { interpretResearch } from "./research-interpreter";
import { message, mockResult } from "./interpret.test-fixtures";
import { applyBriefArtifact, briefInput } from "./research-brief-coordinator";
import { sourceId } from "../jobs/research-brief";
import { researchBriefDefinition } from "../jobs/research-brief";
import { JobService } from "../jobs/service";
import { JobRegistry } from "../jobs/registry";
import { MemoryStorage } from "../storage/memory/adapter";
import { researchDraftHarness } from "./research-draft.test-fixtures";
import { createResearchBriefCoordinator } from "./research-brief-coordinator";
import * as Draft from "@chopin/draft";

async function offer() {
	let input = {
		message: message("source", "Investigate Jev alternatives."),
		recent: [],
		state: initialState(),
	};
	let result = await interpretResearch(
		input,
		async request =>
			mockResult(request.questions, {
				research_warranted: 0.95,
				external: 0.95,
				owned: 0.95,
				research_subject: "explicit",
				research_source: "q0",
				existing_offer: "new",
			}),
	);
	let state = applyResearchOpportunity(input.state, "channel", input, result);
	let offer = state.researchOffers![0]!;
	let artifact = {
		offerId: offer.id,
		generation: 0,
		brief: "Compare alternatives to Jev.",
		model: "fixture",
		sourceIds: [sourceId(offer.source)],
	};
	return { state, offer, artifact };
}

test("brief publication is idempotent and requires the current generation", async () => {
	let h = await offer();
	let updated = applyBriefArtifact(h.offer, h.artifact);
	expect(updated.brief).toBe(h.artifact.brief);
	expect(updated.workflow).toMatchObject({ published: true, preparation: "ready", revision: 1 });
	expect(applyBriefArtifact(updated, h.artifact)).toBe(updated);
	expect(applyBriefArtifact(h.offer, { ...h.artifact, generation: 1 })).toBe(h.offer);
	expect(briefInput(h.offer, h.state).sources).toEqual([h.offer.source]);
});

test("human takeover, dismissal, and invalid evidence prevent replacing a brief", async () => {
	let h = await offer();
	let human = structuredClone(h.offer);
	human.workflow!.mode = "human";
	expect(applyBriefArtifact(human, h.artifact)).toBe(human);
	let dismissed = { ...h.offer, status: "dismissed" as const };
	expect(applyBriefArtifact(dismissed, h.artifact)).toBe(dismissed);
	expect(() => applyBriefArtifact(h.offer, { ...h.artifact, sourceIds: ["forged"] })).toThrow();
});

test("a lost job-link commit reuses the same job after subsequent human edits", async () => {
	let h = researchDraftHarness();
	let storage = new MemoryStorage();
	let now = new Date();
	let user = crypto.randomUUID();
	h.plan.id = crypto.randomUUID();
	await storage.users.put({ id: user, login: "ana", avatarUrl: "", now });
	await storage.channels.create({
		id: h.plan.id,
		repositoryId: crypto.randomUUID(),
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Research",
		createdBy: user,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60000);
	if (!lease) throw new Error("lease missing");
	let jobs = new JobService({
		storage,
		registry: new JobRegistry([
			researchBriefDefinition({ config: { agent: false, model: "fixture" } }),
		]),
		lease: () => lease,
	});
	let coordinator = createResearchBriefCoordinator({ ...h.dependencies, jobs });
	try {
		await h.drafts.edit(h.id, { kind: "begin" }, h.actor);
		h.offer().workflow!.preparation = "pending";
		await h.dependencies.persist();
		h.fail();
		coordinator.wake();
		await coordinator.idle();
		expect(h.offer().workflow!.jobId).toBeUndefined();
		expect(h.errors).toHaveLength(1);
		let model = Draft.restore(h.offer().workflow!.draft!).fork();
		await h.drafts.edit(h.id, {
			kind: "patch",
			patch: Draft.change(model, "Human wording changed after enqueue.")!,
		}, h.actor);
		coordinator.wake();
		await coordinator.idle();
		expect(h.errors).toHaveLength(1);
		expect(h.offer().workflow!.jobId).toBeDefined();
		expect((await jobs.list(h.plan.id, 100))!.jobs).toHaveLength(1);
	} finally {
		coordinator.stop();
		await coordinator.idle();
		await storage.leases.release(lease);
		await storage.close();
	}
});
