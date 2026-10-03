import { describe, expect, test } from "bun:test";
import { actOnResearchOffer, offerResearch, restoreState } from "./domain";
import { renderResearchTask } from "./validation";
import { applyEvent } from "./events";
import {
	ada,
	message,
	optionThread,
	r2Id,
	s3Id,
	taskProposal,
} from "./research-offers.test-fixtures";

describe("research offer domain contract", () => {
	test("freezes two current option labels and a deterministic cost brief", () => {
		let entry = message("cost-source", "R2 egress could matter for thumbnails.");
		let state = optionThread();
		let offer = taskProposal(entry, state);
		let saved = offerResearch(state, offer, entry);
		expect(saved.researchOffers?.[0]?.brief).toBe(
			"Compare current costs for S3 and R2. Discussion context: “R2 egress could matter for thumbnails.”",
		);
		let accepted = actOnResearchOffer(saved, offer.id, {
			id: "accept-cost",
			kind: "research",
			actor: ada,
			principalId: "ada-id",
			at: 10,
		});
		expect(restoreState(accepted, [entry])).toEqual(accepted);
		let linked = applyEvent(accepted, {
			id: "link",
			type: "card.linked",
			threadId: "hosting",
			observedThreadVersion: accepted.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 11,
			questionnaireId: "card-1",
		});
		let relabeled = applyEvent(linked, {
			id: "rename",
			type: "option.relabeled",
			threadId: "hosting",
			observedThreadVersion: linked.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 12,
			optionId: r2Id,
			label: "Cloudflare R2",
			observedCardRevision: 0,
		});
		expect(restoreState(relabeled, [entry])).toEqual(relabeled);
		expect(relabeled.researchOffers?.[0]?.task?.options[1].labelAtOffer).toBe("R2");
		expect(offerResearch(relabeled, offer, entry)).toBe(relabeled);
	});

	test("rejects invented, foreign, duplicate, or changed task labels and briefs", () => {
		let entry = message("cost-source", "Compare our current providers.");
		let state = optionThread();
		let base = taskProposal(entry, state);
		let altered = (change: (offer: typeof base) => void) => {
			let candidate = structuredClone(base);
			change(candidate);
			return candidate;
		};
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.brief = "Invented task";
				}),
				entry,
			)
		)
			.toThrow(/brief/);
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.task!.options[1].labelAtOffer = "Azure Blob";
					offer.brief = renderResearchTask(offer.task!, offer.source);
				}),
				entry,
			)
		).toThrow(/current thread/);
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.task!.options[1].id = "foreign";
					offer.brief = renderResearchTask(offer.task!, offer.source);
				}),
				entry,
			)
		).toThrow(/current thread/);
		let otherThread = applyEvent(state, {
			id: "open-other",
			type: "thread.opened",
			threadId: "other",
			observedThreadVersion: 0,
			origin: "planner",
			actor: { kind: "agent" },
			at: 8,
			question: "Which queue?",
		});
		otherThread = applyEvent(otherThread, {
			id: "add-other",
			type: "option.added",
			threadId: "other",
			observedThreadVersion: otherThread.threads[1]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 9,
			contribution: {
				id: "01K00000000000000000000003",
				text: "Redis",
				authoring: "scribe",
			},
		});
		expect(() =>
			offerResearch(
				otherThread,
				altered(offer => {
					offer.task!.options[1] = {
						id: "01K00000000000000000000003",
						labelAtOffer: "Redis",
					};
					offer.brief = renderResearchTask(offer.task!, offer.source);
				}),
				entry,
			)
		).toThrow(/current thread/);
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.task!.options[1].id = s3Id;
				}),
				entry,
			)
		).toThrow(/duplicate/);
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.task!.options[1].labelAtOffer = "x".repeat(161);
				}),
				entry,
			)
		).toThrow(/text/);
		expect(() =>
			offerResearch(
				state,
				altered(offer => {
					offer.threadId = "foreign-thread";
				}),
				entry,
			)
		).toThrow(/thread/);
		let saved = offerResearch(state, base, entry);
		let forged = structuredClone(saved);
		forged.researchOffers![0].task!.options[1].labelAtOffer = "Azure Blob";
		forged.researchOffers![0].brief = renderResearchTask(
			forged.researchOffers![0].task!,
			forged.researchOffers![0].source,
		);
		expect(() => restoreState(forged, [entry])).toThrow(/history/);
		let wrongSource = structuredClone(saved);
		wrongSource.researchOffers![0].source.quote = "forged exact quote";
		wrongSource.researchOffers![0].source.end = "forged exact quote".length;
		wrongSource.researchOffers![0].brief = renderResearchTask(
			wrongSource.researchOffers![0].task!,
			wrongSource.researchOffers![0].source,
		);
		expect(() => restoreState(wrongSource, [entry])).toThrow(/source quote/);
	});
});
