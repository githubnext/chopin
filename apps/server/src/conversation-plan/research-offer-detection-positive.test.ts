import { describe, expect, test } from "bun:test";
import { applyEvent } from "./events";
import type { Interpretation } from "./interpret";
import { renderResearchTask } from "./validation";
import {
	ada,
	d03Options,
	d04Options,
	detectResearchOffer,
	entry,
	exactSource,
	harness,
	inputInterpreter,
	postmarkId,
	processMessage,
	r2Id,
	relayId,
	s3Id,
	seededThread,
	sesId,
	sharedDiskId,
} from "./research-offer-detection.test-fixtures";
import type { ResearchJudgment } from "./research-offer-detection.test-fixtures";

// Whole archived callbacks; only suite wrappers and imports change.
describe("proactive current-cost research offers", () => {
	test("uses a relabeled option's effective card label without starting work", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "S3" },
			{ id: r2Id, text: "R2" },
		]);
		state = applyEvent(state, {
			id: "rename-r2-for-card",
			type: "option.relabeled",
			threadId: "storage",
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 10,
			optionId: r2Id,
			label: "Cloudflare R2",
			observedCardRevision: 0,
		});
		let message = entry("D04-m5", "Cloudflare R2's egress could matter for thumbnails.", 11);
		let quote = "Cloudflare R2's egress could matter for thumbnails.";
		let candidate: NonNullable<Interpretation["researchOffer"]> = {
			source: exactSource(message, quote),
			threadId: "storage",
			optionIds: [s3Id, r2Id],
		};
		let setup = harness(state, async () => ({
			events: [],
			researchOffer: candidate,
			analysis: {
				questionSetVersion: "test",
				modelVersion: "fake-jev",
				status: "unlinked",
				passes: [],
			},
		}));
		let starts = 0;
		await processMessage(setup, message);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer).toMatchObject({
			status: "offered",
			source: candidate.source,
			task: {
				kind: "current-cost-comparison",
				threadId: "storage",
				options: [
					{ id: s3Id, labelAtOffer: "S3" },
					{ id: r2Id, labelAtOffer: "Cloudflare R2" },
				],
			},
		});
		expect(offer?.brief).toBe(renderResearchTask(offer!.task!, offer!.source));
		expect(setup.durable.pending).toEqual([]);
		expect(setup.durable.receipts).toEqual([]);
		expect(starts).toBe(0);

		let consent = await setup.processor.researchConsent(
			{ offerId: offer!.id, choice: "research", actionId: "click-research" },
			ada,
			"ada-principal",
			async accepted => {
				starts++;
				expect(accepted.brief).toBe(offer!.brief);
				return { execution: "started", researchRequestId: "request-1" };
			},
		);
		expect(consent.execution).toBe("started");
		expect(starts).toBe(1);
		setup.processor.stop();
	});

	test("detects D03's generic two-option cost need without starting work before consent", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let message = entry("D03-m4", "I don't know current provider prices.", 11);
		let quote = message.text;
		let judgment: ResearchJudgment = {
			threadId: "mail",
			optionIds: [postmarkId, sesId],
			quote,
		};
		let interpretation = await detectResearchOffer(state, message, judgment);
		expect(interpretation.researchOffer).toMatchObject({
			threadId: "mail",
			optionIds: [postmarkId, sesId],
			source: exactSource(message, quote),
		});

		let setup = harness(state, inputInterpreter(() => judgment), [message]);
		await processMessage(setup, message);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer).toMatchObject({
			status: "offered",
			source: exactSource(message, quote),
			task: {
				kind: "current-cost-comparison",
				threadId: "mail",
				options: [
					{ id: postmarkId, labelAtOffer: "Postmark" },
					{ id: sesId, labelAtOffer: "Amazon SES" },
				],
			},
			brief: `Compare current costs for Postmark and Amazon SES. Discussion context: “${quote}”`,
		});
		expect(setup.durable.pending).toEqual([]);
		expect(setup.durable.receipts).toEqual([]);
		setup.processor.stop();
	});

	test("D03 generic provider-price uncertainty offers all three options without a pair or focus", async () => {
		let state = d03Options();
		let message = entry("D03-m4-three-options", "I don't know current provider prices.", 11);
		let judgment: ResearchJudgment = {
			threadId: "mail",
			optionIds: [relayId, postmarkId, sesId],
			quote: message.text,
			kind: "current-cost-concern",
			scopeChoice: "all-current",
		};
		let interpretation = await detectResearchOffer(state, message, judgment);
		expect(interpretation.researchOffer).toMatchObject({
			kind: "current-cost-concern",
			threadId: "mail",
			optionIds: [relayId, postmarkId, sesId],
			source: exactSource(message, message.text),
		});
		expect((interpretation.researchOffer as unknown as { focusOptionId?: string })?.focusOptionId)
			.toBeUndefined();

		let setup = harness(state, inputInterpreter(() => judgment), [message]);
		await processMessage(setup, message);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer).toMatchObject({
			status: "offered",
			source: exactSource(message, message.text),
			task: {
				kind: "current-cost-concern",
				threadId: "mail",
				options: [
					{ id: relayId, labelAtOffer: "SMTP relay" },
					{ id: postmarkId, labelAtOffer: "Postmark" },
					{ id: sesId, labelAtOffer: "Amazon SES" },
				],
			},
		});
		expect((offer?.task as unknown as { focusOptionId?: string })?.focusOptionId).toBeUndefined();
		expect(offer?.brief).toBe(renderResearchTask(offer!.task!, offer!.source));
		for (let label of ["SMTP relay", "Postmark", "Amazon SES", message.text]) {
			expect(offer?.brief).toContain(label);
		}
		expect(setup.durable.pending).toEqual([]);
		expect(setup.durable.receipts).toEqual([]);
		setup.processor.stop();
	});

	test("D04 R2 egress focuses R2 while S3 and shared disk remain in context", async () => {
		let state = d04Options();
		let message = entry("D04-m5-three-options", "R2's egress could matter for thumbnails.", 11);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: message.text,
			kind: "current-cost-concern",
			scopeChoice: r2Id,
		};
		let interpretation = await detectResearchOffer(state, message, judgment);
		expect(interpretation.researchOffer).toMatchObject({
			kind: "current-cost-concern",
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			source: exactSource(message, message.text),
		});
		expect((interpretation.researchOffer as unknown as { focusOptionId?: string })?.focusOptionId)
			.toBe(r2Id);

		let setup = harness(state, inputInterpreter(() => judgment));
		let starts = 0;
		await processMessage(setup, message);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer).toMatchObject({
			status: "offered",
			source: exactSource(message, message.text),
			task: {
				kind: "current-cost-concern",
				threadId: "storage",
				focusOptionId: r2Id,
				options: [
					{ id: s3Id, labelAtOffer: "Amazon S3" },
					{ id: sharedDiskId, labelAtOffer: "shared disk" },
					{ id: r2Id, labelAtOffer: "Cloudflare R2" },
				],
			},
		});
		expect(offer?.brief).toBe(renderResearchTask(offer!.task!, offer!.source));
		expect(offer?.brief).toContain(
			"Investigate current costs for Cloudflare R2; consider Amazon S3, shared disk as context.",
		);
		expect(setup.durable.pending).toEqual([]);
		expect(setup.durable.receipts).toEqual([]);
		expect(starts).toBe(0);
		let consent = await setup.processor.researchConsent(
			{ offerId: offer!.id, choice: "research", actionId: "D04-click-research" },
			ada,
			"ada-principal",
			async accepted => {
				starts++;
				expect(accepted.brief).toBe(offer!.brief);
				return { execution: "started", researchRequestId: "D04-request" };
			},
		);
		expect(consent.execution).toBe("started");
		expect(starts).toBe(1);
		setup.processor.stop();
	});

	test("D04 focuses R2 when its current option label contains a longer question", async () => {
		let state = seededThread("storage", "Where should uploaded images live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: sharedDiskId, text: "shared disk" },
			{ id: r2Id, text: "is R2 still worth comparing, or did we rule it out?" },
		]);
		let message = entry("D04-long-r2-label", "R2's egress could matter for thumbnails.", 11);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: message.text,
			kind: "current-cost-concern",
			scopeChoice: r2Id,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer).toMatchObject({
			status: "offered",
			source: exactSource(message, message.text),
			task: {
				kind: "current-cost-concern",
				threadId: "storage",
				focusOptionId: r2Id,
				options: [
					{ id: s3Id, labelAtOffer: "Amazon S3" },
					{ id: sharedDiskId, labelAtOffer: "shared disk" },
					{
						id: r2Id,
						labelAtOffer: "is R2 still worth comparing, or did we rule it out?",
					},
				],
			},
		});
		expect(offer?.brief).toBe(renderResearchTask(offer!.task!, offer!.source));
		expect(offer?.source).toEqual(exactSource(message, message.text));
		expect(setup.durable.pending).toEqual([]);
		expect(setup.durable.receipts).toEqual([]);
		setup.processor.stop();
	});
});
