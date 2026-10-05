import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { applyResearchOpportunity } from "./research-opportunities";
import { interpretResearch } from "./research-interpreter";
import { message, mockResult } from "./interpret.test-fixtures";
import { applyBriefArtifact, briefInput } from "./research-brief-coordinator";
import { sourceId } from "../jobs/research-brief";

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
				clear_subject: 0.95,
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
