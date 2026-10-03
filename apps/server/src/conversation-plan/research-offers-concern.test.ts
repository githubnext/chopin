import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { restoreState } from "./domain";
import { renderResearchTask } from "./validation";
import { applyEvent } from "./events";
import {
	ada,
	costConcernProposal,
	type CostConcernTask,
	diskId,
	exactSource,
	mailgunId,
	message,
	offerCostConcern,
	postmarkId,
	r2Id,
	s3Id,
	sesId,
	stateWithOptions,
} from "./research-offers.test-fixtures";

describe("research offer domain contract", () => {
	test("generic current-price uncertainty freezes all providers without a chosen focus", () => {
		let entry = message("d03-cost-source", "I don't know current provider prices.");
		let state = stateWithOptions("providers", "Which email provider?", [
			{ id: postmarkId, label: "Postmark" },
			{ id: sesId, label: "Amazon SES" },
			{ id: mailgunId, label: "Mailgun" },
		]);
		let candidate = costConcernProposal(entry, state, undefined, entry.text, "providers");
		let saved = offerCostConcern(state, candidate, entry);
		let offer = saved.researchOffers?.[0];
		if (!offer) throw new Error("cost concern was not stored");
		expect((offer.task as unknown as CostConcernTask).kind).toBe("current-cost-concern");
		expect((offer.task as unknown as CostConcernTask).options).toEqual([
			{ id: postmarkId, labelAtOffer: "Postmark" },
			{ id: sesId, labelAtOffer: "Amazon SES" },
			{ id: mailgunId, labelAtOffer: "Mailgun" },
		]);
		expect((offer.task as unknown as CostConcernTask).focusOptionId).toBeUndefined();
		expect(offer.source).toEqual(exactSource(entry));
		expect(offer.brief).toBe(renderResearchTask(
			offer.task as unknown as ConversationPlan.ResearchTask,
			offer.source,
		));
		for (let label of ["Postmark", "Amazon SES", "Mailgun", entry.text]) {
			expect(offer.brief).toContain(label);
		}
		expect(restoreState(structuredClone(saved), [entry])).toEqual(saved);
	});

	test("an R2 egress concern focuses R2 while retaining every storage option as context", () => {
		let entry = message("d04-egress-source", "R2 egress could matter for thumbnails.");
		let state = stateWithOptions("storage", "Where should we store uploaded images?", [
			{ id: s3Id, label: "Amazon S3" },
			{ id: r2Id, label: "Cloudflare R2" },
			{ id: diskId, label: "Local disk" },
		]);
		let candidate = costConcernProposal(entry, state, r2Id);
		let saved = offerCostConcern(state, candidate, entry);
		let offer = saved.researchOffers?.[0];
		if (!offer) throw new Error("cost concern was not stored");
		expect((offer.task as unknown as CostConcernTask).kind).toBe("current-cost-concern");
		expect((offer.task as unknown as CostConcernTask).options).toEqual([
			{ id: s3Id, labelAtOffer: "Amazon S3" },
			{ id: r2Id, labelAtOffer: "Cloudflare R2" },
			{ id: diskId, labelAtOffer: "Local disk" },
		]);
		expect((offer.task as unknown as CostConcernTask).focusOptionId).toBe(r2Id);
		expect(offer.source).toEqual(exactSource(entry));
		expect(offer.brief).toBe(renderResearchTask(
			offer.task as unknown as ConversationPlan.ResearchTask,
			offer.source,
		));
		for (let label of ["Amazon S3", "Cloudflare R2", "Local disk", entry.text]) {
			expect(offer.brief).toContain(label);
		}
		expect(restoreState(structuredClone(saved), [entry])).toEqual(saved);
	});

	test("multi-option concerns reject stale labels, duplicate IDs, and an invalid focus", () => {
		let entry = message("d04-stale-source", "R2 egress could matter for thumbnails.");
		entry.ts = 1_800_000_000;
		let state = stateWithOptions("storage", "Where should we store uploaded images?", [
			{ id: s3Id, label: "Amazon S3" },
			{ id: r2Id, label: "Cloudflare R2" },
			{ id: diskId, label: "Local disk" },
		]);
		let candidate = costConcernProposal(entry, state, r2Id);
		let offered = offerCostConcern(state, candidate, entry);
		let renamed = applyEvent(offered, {
			id: "human:rename-r2",
			type: "card.corrected",
			threadId: "storage",
			observedThreadVersion: offered.threads[0]!.version,
			origin: "human",
			actor: ada,
			at: 1_800_000_001_000,
			change: { kind: "edit", field: "contribution", contributionId: r2Id, text: "Backblaze B2" },
		});
		expect(restoreState(structuredClone(renamed), [entry])).toEqual(renamed);
		let afterRename = message("d04-after-rename", entry.text);
		afterRename.ts = 1_800_000_002;
		let stale = costConcernProposal(afterRename, state, r2Id);
		expect(() => offerCostConcern(renamed, stale, afterRename)).toThrow(/current thread/);
		expect(() => restoreState(structuredClone(renamed), [{ ...entry, ts: afterRename.ts }]))
			.toThrow(/postdates/);

		let duplicate = structuredClone(candidate);
		duplicate.task.options[2]!.id = duplicate.task.options[1]!.id;
		duplicate.brief = renderResearchTask(
			duplicate.task as unknown as ConversationPlan.ResearchTask,
			duplicate.source,
		);
		expect(() => offerCostConcern(state, duplicate, entry)).toThrow(/duplicate/);

		let invalidFocus = structuredClone(candidate);
		invalidFocus.task.focusOptionId = postmarkId;
		invalidFocus.brief = renderResearchTask(
			invalidFocus.task as unknown as ConversationPlan.ResearchTask,
			invalidFocus.source,
		);
		let rejected = false;
		try {
			let result = offerCostConcern(state, invalidFocus, entry);
			rejected = result.researchOffers?.length !== 1;
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	test("an old R2-only quote cannot become a generic concern after R2 is relabeled", () => {
		let state = stateWithOptions("storage", "Where should we store uploaded images?", [
			{ id: s3Id, label: "Amazon S3" },
			{ id: r2Id, label: "Cloudflare R2" },
			{ id: diskId, label: "Local disk" },
		]);
		let renamed = applyEvent(state, {
			id: "human:rename-r2-before-new-concern",
			type: "card.corrected",
			threadId: "storage",
			observedThreadVersion: state.threads[0]!.version,
			origin: "human",
			actor: ada,
			at: 1_800_000_001_000,
			change: { kind: "edit", field: "contribution", contributionId: r2Id, text: "Backblaze B2" },
		});
		let entry = message("d04-old-r2-name", "R2 egress could matter for thumbnails.");
		let candidate = costConcernProposal(entry, renamed, undefined);
		let rejected = false;
		try {
			let result = offerCostConcern(renamed, candidate, entry);
			rejected = result.researchOffers?.length !== 1;
		} catch {
			rejected = true;
		}
		expect(candidate.task.focusOptionId).toBeUndefined();
		expect(rejected).toBe(true);
	});
});
