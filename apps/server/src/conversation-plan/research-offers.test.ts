import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { actOnResearchOffer, initialState, offerResearch, restoreState } from "./domain";
import { MAX_RESEARCH_OFFERS } from "./validation";
import { ada, bo, message, proposal } from "./research-offers.test-fixtures";

describe("research offer domain contract", () => {
	test("keeps exact UTF-16 source and brief through restore; old sidecars remain valid", () => {
		let entry = message("m1");
		let input = proposal(entry);
		let state = offerResearch(initialState(), input, entry);
		input.source.quote = "changed";
		expect(state.researchOffers?.[0]?.brief).toBe(entry.text);
		expect(state.researchOffers?.[0]?.source.end).toBe(entry.text.length);
		expect(restoreState(structuredClone(state), [entry])).toEqual(state);
		let { researchOffers: _offers, ...old } = initialState();
		expect(restoreState(old).researchOffers).toBeUndefined();
		expect(offerResearch(old, proposal(entry), entry).researchOffers).toHaveLength(1);
	});

	test("rejects forged quote, range, author, brief and missing thread on creation or restore", () => {
		let entry = message("m1");
		let base = proposal(entry);
		let badQuote = structuredClone(base);
		badQuote.source.quote = "forged";
		expect(() => offerResearch(initialState(), badQuote, entry)).toThrow();
		let badRange = structuredClone(base);
		badRange.source.end -= 1;
		expect(() => offerResearch(initialState(), badRange, entry)).toThrow();
		let badAuthor = structuredClone(base);
		badAuthor.source.author = { kind: "member", handle: "bo" };
		expect(() => offerResearch(initialState(), badAuthor, entry)).toThrow();
		let badBrief = structuredClone(base);
		badBrief.brief = "polished but not the quote";
		expect(() => offerResearch(initialState(), badBrief, entry)).toThrow();
		expect(() =>
			offerResearch(
				initialState(),
				{
					...base,
					status: "accepted",
				} as typeof base,
				entry,
			)
		).toThrow(/proposal/);
		expect(() => offerResearch(initialState(), { ...base, threadId: "absent" }, entry))
			.toThrow(/thread/);
		let saved = offerResearch(initialState(), base, entry);
		expect(() => restoreState(saved, [])).toThrow(/missing/);
		let altered = structuredClone(saved);
		altered.researchOffers![0].source.quote = "forged";
		expect(() => restoreState(altered, [entry])).toThrow();
	});

	test("first terminal action wins, exact retries are no-ops, conflicting clicks fail", () => {
		let entry = message("m1");
		let offered = offerResearch(initialState(), proposal(entry), entry);
		expect(offerResearch(offered, proposal(entry), entry)).toBe(offered);
		let research: ConversationPlan.ResearchAction = {
			id: "act-1",
			kind: "research",
			actor: ada,
			principalId: "ada-id",
			at: 2,
		};
		let accepted = actOnResearchOffer(offered, "offer:m1", research);
		expect(accepted.researchOffers?.[0]).toMatchObject({ status: "accepted", action: research });
		expect(actOnResearchOffer(accepted, "offer:m1", research)).toBe(accepted);
		expect(actOnResearchOffer(accepted, "offer:m1", { ...research, at: 99 })).toBe(accepted);
		expect(accepted.researchOffers?.[0]?.action?.at).toBe(2);
		expect(() =>
			actOnResearchOffer(accepted, "offer:m1", {
				id: "act-2",
				kind: "dismiss",
				actor: bo,
				principalId: "bo-id",
				at: 3,
			})
		).toThrow(/terminal/);
		expect(() =>
			actOnResearchOffer(accepted, "offer:m1", {
				...research,
				principalId: "different-id",
			})
		).toThrow(/terminal/);
		expect(() =>
			actOnResearchOffer(accepted, "offer:m1", {
				...research,
				actor: bo,
			})
		).toThrow(/terminal/);
		expect(restoreState(accepted, [entry])).toEqual(accepted);
		let invalid = structuredClone(accepted);
		invalid.researchOffers![0].status = "dismissed";
		expect(() => restoreState(invalid)).toThrow(/disagrees/);
		let unacted = structuredClone(accepted);
		unacted.researchOffers![0].action = undefined;
		expect(() => restoreState(unacted)).toThrow();
		let noPrincipal = structuredClone(accepted);
		noPrincipal.researchOffers![0].action!.principalId = "";
		expect(() => restoreState(noPrincipal)).toThrow();
	});

	test("retains dismissed need/context suppression, permits a new context, fails closed at cap", () => {
		let first = message("m1");
		let dismissed = actOnResearchOffer(
			offerResearch(initialState(), proposal(first), first),
			"offer:m1",
			{ id: "dismiss-1", kind: "dismiss", actor: ada, principalId: "ada-id", at: 2 },
		);
		let second = message("m2");
		expect(() => offerResearch(dismissed, proposal(second), second)).toThrow(/duplicate/);
		let changed = offerResearch(
			dismissed,
			proposal(second, "offer:m2", "hosting-terms", "v2"),
			second,
		);
		expect(changed.researchOffers?.[0]?.status).toBe("dismissed");
		expect(changed.researchOffers).toHaveLength(2);
		expect(() =>
			actOnResearchOffer(changed, "offer:m2", {
				id: "dismiss-1",
				kind: "dismiss",
				actor: bo,
				principalId: "bo-id",
				at: 3,
			})
		).toThrow(/already used/);
		let full = initialState();
		for (let index = 0; index < MAX_RESEARCH_OFFERS; index++) {
			let entry = message(`m${index}`);
			full = offerResearch(full, proposal(entry, `offer:${index}`, `need:${index}`), entry);
		}
		expect(() =>
			offerResearch(full, proposal(message("overflow"), "overflow", "new"), message("overflow"))
		).toThrow(/full/);
		expect(full.researchOffers).toHaveLength(MAX_RESEARCH_OFFERS);
	});
});
