import { describe, expect, test } from "bun:test";
import {
	ada,
	d03Options,
	entry,
	exactSource,
	expectNoDurableOffer,
	harness,
	inputInterpreter,
	postmarkId,
	processMessage,
	r2Id,
	relayId,
	resendId,
	s3Id,
	seededThread,
	sesId,
	sharedDiskId,
	waitFor,
} from "./research-offer-detection.test-fixtures";
import type { ResearchJudgment } from "./research-offer-detection.test-fixtures";

// Whole archived callbacks; only suite wrappers and imports change.
describe("proactive current-cost research offers", () => {
	test("rejects missing, partial, and ambiguous R2 focus names", async () => {
		let message = entry("D04-invalid-r2-focus", "R2's egress could matter for thumbnails.", 11);
		let base: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: message.text,
			kind: "current-cost-concern",
			scopeChoice: r2Id,
		};

		await expectNoDurableOffer(
			seededThread("storage", "Where should images live?", [
				{ id: s3Id, text: "Amazon S3" },
				{ id: sharedDiskId, text: "shared disk" },
				{ id: r2Id, text: "Cloudflare R2" },
			]),
			entry("D04-b2-not-present", "B2's egress could matter for thumbnails.", 11),
			{ ...base, quote: "B2's egress could matter for thumbnails." },
		);
		await expectNoDurableOffer(
			seededThread("storage", "Where should images live?", [
				{ id: s3Id, text: "Amazon S3" },
				{ id: sharedDiskId, text: "shared disk" },
				{ id: r2Id, text: "Cloudflare R2" },
			]),
			entry("D04-r2x-not-whole-token", "R2x's egress could matter for thumbnails.", 11),
			{ ...base, quote: "R2x's egress could matter for thumbnails." },
		);
		await expectNoDurableOffer(
			seededThread("storage", "Where should images live?", [
				{ id: s3Id, text: "Amazon S3" },
				{ id: sharedDiskId, text: "shared disk" },
				{ id: r2Id, text: "Cloudflare R2" },
				{ id: resendId, text: "Wasabi R2" },
			]),
			message,
			{ ...base, optionIds: [s3Id, sharedDiskId, r2Id, resendId] },
		);
		await expectNoDurableOffer(
			seededThread("storage", "Where should images live?", [
				{ id: resendId, text: "Amazon S3 / Cloudflare R2" },
				{ id: sharedDiskId, text: "shared disk" },
				{ id: r2Id, text: "Wasabi" },
			]),
			entry(
				"D04-compound-option-focus",
				"Amazon S3 / Cloudflare R2's egress could matter for thumbnails.",
				11,
			),
			{
				...base,
				optionIds: [resendId, sharedDiskId, r2Id],
				quote: "Amazon S3 / Cloudflare R2's egress could matter for thumbnails.",
				scopeChoice: resendId,
			},
		);
	});

	test("revalidates a research-only offer against the linked card at commit", async () => {
		let state = d03Options();
		let message = entry(
			"D03-card-changed-during-interpretation",
			"I don't know current provider prices.",
			11,
		);
		let ready!: () => void;
		let release!: () => void;
		let interpretationStarted = new Promise<void>(resolve => ready = resolve);
		let allowCommit = new Promise<void>(resolve => release = resolve);
		let setup = harness(state, async () => {
			ready();
			await allowCommit;
			return {
				events: [],
				researchOffer: {
					kind: "current-cost-concern",
					threadId: "mail",
					optionIds: [relayId, postmarkId, sesId],
					source: exactSource(message, message.text),
				},
				analysis: {
					questionSetVersion: "test",
					modelVersion: "fake-jev",
					status: "unlinked",
					passes: [],
				},
			};
		});
		let originalCard = {
			threadId: "mail",
			status: "open",
			definition: {
				questions: [{
					options: [
						{ id: relayId, label: "SMTP relay" },
						{ id: postmarkId, label: "Postmark" },
						{ id: sesId, label: "Amazon SES" },
					],
				}],
			},
			history: [],
		};
		setup.plan.records.set("card-mail", originalCard as never);

		await setup.processor.accept(message);
		setup.processor.afterMessage();
		await interpretationStarted;
		setup.plan.records.set("card-mail", {
			...originalCard,
			definition: {
				questions: [{
					options: [
						...originalCard.definition.questions[0]!.options,
						{ id: resendId, label: "Resend" },
					],
				}],
			},
		} as never);
		release();
		await waitFor(() => setup.durable.state.analysis.some(item => item.messageId === message.id));

		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.threads.find(item => item.id === "mail")?.contributions)
			.toHaveLength(3);
		expect(setup.durable.state.analysis.find(item => item.messageId === message.id)).toMatchObject({
			messageId: message.id,
			status: "unlinked",
		});
		expect(setup.errors).toEqual([]);
		setup.processor.stop();
	});

	test("does not offer from a card whose option snapshot already differs from its thread", async () => {
		let state = d03Options();
		let message = entry(
			"D03-card-already-has-fourth-option",
			"I don't know current provider prices.",
			11,
		);
		let setup = harness(state, async input => {
			expect(input.linkedCards?.get("mail")?.options).toHaveLength(4);
			return {
				events: [],
				researchOffer: {
					kind: "current-cost-concern",
					threadId: "mail",
					optionIds: [relayId, postmarkId, sesId],
					source: exactSource(message, message.text),
				},
				analysis: {
					questionSetVersion: "test",
					modelVersion: "fake-jev",
					status: "unlinked",
					passes: [],
				},
			};
		});
		setup.plan.records.set("card-mail", {
			threadId: "mail",
			status: "open",
			definition: {
				questions: [{
					options: [
						{ id: relayId, label: "SMTP relay" },
						{ id: postmarkId, label: "Postmark" },
						{ id: sesId, label: "Amazon SES" },
						{ id: resendId, label: "Resend" },
					],
				}],
			},
			history: [],
		} as never);

		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.find(item => item.messageId === message.id)).toMatchObject({
			messageId: message.id,
			status: "unlinked",
		});
		expect(setup.errors).toEqual([]);
		setup.processor.stop();
	});

	test("dismissed D03 current-price uncertainty suppresses a generic same-context paraphrase", async () => {
		let state = d03Options();
		let first = entry("D03-m4-dismiss", "I don't know current provider prices.", 11);
		let second = entry("D03-m7-paraphrase", "We still need current provider pricing.", 12);
		let setup = harness(
			state,
			inputInterpreter(message => ({
				threadId: "mail",
				optionIds: [relayId, postmarkId, sesId],
				quote: message.text,
				kind: "current-cost-concern",
				scopeChoice: "all-current",
			})),
		);
		let starts = 0;
		await processMessage(setup, first);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer?.status).toBe("offered");
		let dismissed = await setup.processor.researchConsent(
			{ offerId: offer!.id, choice: "dismiss", actionId: "D03-dismiss" },
			ada,
			"ada-principal",
			async () => {
				starts++;
				return { execution: "started", researchRequestId: "should-not-start" };
			},
		);
		expect(dismissed.execution).toBe("none");
		await processMessage(setup, second);
		expect(setup.durable.state.researchOffers).toHaveLength(1);
		expect(setup.durable.state.researchOffers?.[0]?.status).toBe("dismissed");
		expect(starts).toBe(0);
		setup.processor.stop();
	});
});
