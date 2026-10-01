import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyEvent } from "./events";
import type { Interpretation } from "./interpret";
import type { JevAnswer } from "./jev";
import {
	ada,
	d03Options,
	detectResearchOffer,
	entry,
	exactSource,
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
} from "./research-offer-detection.test-fixtures";
import type { ResearchJudgment } from "./research-offer-detection.test-fixtures";

// Whole archived callbacks; only suite wrappers and imports change.
describe("proactive current-cost research offers", () => {
	test("a replayed D03 generic concern does not publish a duplicate offer", async () => {
		let state = d03Options();
		let first = entry("D03-replay-first", "I don't know current provider prices.", 11);
		let replay = entry("D03-replay-again", "I don't know current provider prices.", 12);
		let setup = harness(
			state,
			inputInterpreter(() => ({
				threadId: "mail",
				optionIds: [relayId, postmarkId, sesId],
				quote: first.text,
				kind: "current-cost-concern",
				scopeChoice: "all-current",
			})),
		);
		await processMessage(setup, first);
		await processMessage(setup, replay);
		expect(setup.durable.state.researchOffers).toHaveLength(1);
		expect(setup.durable.state.analysis.some(item => item.messageId === first.id)).toBe(true);
		expect(setup.durable.state.analysis.some(item => item.messageId === replay.id)).toBe(true);
		expect(setup.durable.entries.filter(item => item.id === replay.id)).toHaveLength(1);
		setup.processor.stop();
	});

	test("rejects a stale label at admission but accepts a fresh quote naming the current label", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		state = applyEvent(state, {
			id: "rename-r2",
			type: "option.relabeled",
			threadId: "storage",
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 10,
			optionId: r2Id,
			label: "Backblaze B2",
			observedCardRevision: 0,
		});
		let staleMessage = entry(
			"storage-old-label",
			"Compare Amazon S3 and Cloudflare R2 costs.",
			11,
		);
		let staleJudgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: staleMessage.text,
		};
		let stale = await detectResearchOffer(state, staleMessage, staleJudgment);
		expect(stale.researchOffer).toBeDefined();
		let staleSetup = harness(state, inputInterpreter(() => staleJudgment));
		await processMessage(staleSetup, staleMessage);
		expect(staleSetup.durable.state.researchOffers ?? []).toEqual([]);
		expect(staleSetup.durable.state.analysis.some(item => item.messageId === staleMessage.id))
			.toBe(true);
		staleSetup.processor.stop();

		let currentMessage = entry(
			"storage-current-label",
			"Compare Amazon S3 and Backblaze B2 costs.",
			12,
		);
		let currentJudgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: currentMessage.text,
		};
		let current = await detectResearchOffer(state, currentMessage, currentJudgment);
		expect(current.researchOffer).toMatchObject({
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			source: exactSource(currentMessage, currentMessage.text),
		});

		let setup = harness(state, inputInterpreter(() => currentJudgment));
		await processMessage(setup, currentMessage);
		expect(setup.durable.state.researchOffers?.[0]).toMatchObject({
			task: {
				options: [
					{ id: s3Id, labelAtOffer: "Amazon S3" },
					{ id: r2Id, labelAtOffer: "Backblaze B2" },
				],
			},
			brief:
				`Compare current costs for Amazon S3 and Backblaze B2. Discussion context: “${currentMessage.text}”`,
		});
		setup.processor.stop();
	});

	test("does not pair a selected option with a different explicitly named option", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
			{ id: resendId, text: "Redis" },
		]);
		let message = entry("wrong-pair", "Compare Amazon S3 and Redis costs.", 11);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let interpretation = await detectResearchOffer(state, message, judgment);
		expect(interpretation.researchOffer).toBeUndefined();
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("does not turn a named outside alternative into an S3/R2 comparison", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		let message = entry("outside-option", "Compare Amazon S3 and Redis costs.", 11);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("does not pair S3/R2 when a third provider is also named", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		let message = entry(
			"multiple-named-providers",
			"Compare Amazon S3 and Cloudflare R2 and Redis costs.",
			11,
		);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("rejects an outside operand in a short explicit alternative", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		let message = entry("outside-or", "Amazon S3 or Redis costs?", 11);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("rejects an outside operand in a how-do-they-compare question", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		let message = entry(
			"outside-how-compare",
			"How do Amazon S3 and Redis costs compare?",
			12,
		);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("rejects an outside option in a comparative-cost statement", async () => {
		let state = seededThread("storage", "Where should originals live?", [
			{ id: s3Id, text: "Amazon S3" },
			{ id: r2Id, text: "Cloudflare R2" },
		]);
		let message = entry(
			"outside-than",
			"Amazon S3 is cheaper than Redis at current prices.",
			13,
		);
		let judgment: ResearchJudgment = {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: message.text,
		};
		let setup = harness(state, inputInterpreter(() => judgment));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.analysis.some(item => item.messageId === message.id)).toBe(true);
		setup.processor.stop();
	});

	test("does not offer quoted cost concerns owned only by the research follow-up", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let message = entry("quoted-cost", "They asked, ‘I don't know current provider prices.’", 11);
		let result = await detectResearchOffer(state, message, {
			threadId: "mail",
			optionIds: [postmarkId, sesId],
			quote: "I don't know current provider prices.",
			triageOwned: 0.1,
			owned: 0.99,
		});
		expect(result.researchOffer).toBeUndefined();
	});

	test("requires an open two-option thread and confident, unanswered, speaker-owned evidence", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let message = entry("guarded-cost", "I don't know current provider prices.", 11);
		let base: ResearchJudgment = {
			threadId: "mail",
			optionIds: [postmarkId, sesId],
			quote: message.text,
		};
		let lowConfidence: JevAnswer = {
			type: "choice",
			choice: postmarkId,
			confidence: 0.79,
			probabilities: { [postmarkId]: 0.95, [sesId]: 0.05, none: 0 },
		};
		let cases: Array<{ state: ConversationPlan.State; judgment: ResearchJudgment }> = [
			{ state, judgment: { ...base, need: 0.79 } },
			{ state, judgment: { ...base, answered: 0.95 } },
			{ state, judgment: { ...base, optionAAnswer: lowConfidence } },
			{ state, judgment: { ...base, triageOwned: 0.1, owned: 0.1 } },
			{
				state: seededThread("mail", "Which email provider should we use?", [
					{ id: postmarkId, text: "Postmark" },
				]),
				judgment: base,
			},
			{
				state: seededThread("mail", "Which email provider should we use?", [
					{ id: postmarkId, text: "Postmark" },
					{ id: sesId, text: "Amazon SES" },
				], "decided"),
				judgment: base,
			},
		];
		for (let item of cases) {
			let result = await detectResearchOffer(item.state, message, item.judgment);
			expect(result.researchOffer).toBeUndefined();
		}
	});

	test("suppresses a dismissed same-context paraphrase without starting research", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let first = entry("dismiss-first", "I don't know current provider prices.", 11);
		let second = entry("dismiss-paraphrase", "We still need current provider pricing.", 12);
		let setup = harness(
			state,
			inputInterpreter(message => ({
				threadId: "mail",
				optionIds: [postmarkId, sesId],
				quote: message.text,
			})),
		);
		let starts = 0;
		await processMessage(setup, first);
		let offer = setup.durable.state.researchOffers?.[0];
		expect(offer?.status).toBe("offered");
		let dismissed = await setup.processor.researchConsent(
			{ offerId: offer!.id, choice: "dismiss", actionId: "dismiss-first" },
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

	test("persists valid planning events when the optional offer is rejected", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let message = entry("planning-survives", "Postmark is the current preference.", 11);
		let candidate: NonNullable<Interpretation["researchOffer"]> = {
			source: exactSource(message, message.text),
			threadId: "mail",
			optionIds: [postmarkId, "not-a-current-option"],
		};
		let event: ConversationPlan.Event = {
			id: "support-postmark",
			type: "stance.changed",
			threadId: "mail",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: message.ts,
			source: { ...candidate.source, role: "support" },
			optionId: postmarkId,
			position: "support",
		};
		let setup = harness(state, async () => ({
			events: [event],
			researchOffer: candidate,
			analysis: {
				questionSetVersion: "test",
				modelVersion: "fake-jev",
				status: "applied",
				passes: [],
			},
		}));
		await processMessage(setup, message);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.durable.state.threads[0]?.stances).toContainEqual(
			expect.objectContaining({ participant: "ada", optionId: postmarkId, position: "support" }),
		);
		expect(setup.durable.state.analysis.find(item => item.messageId === message.id)?.eventIds)
			.toContain(event.id);
		setup.processor.stop();
	});

	test("publishes no offer when the offer-and-analysis commit fails", async () => {
		let state = seededThread("mail", "Which email provider should we use?", [
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
		]);
		let message = entry("failed-offer-commit", "I don't know current provider prices.", 11);
		let setup = harness(
			state,
			inputInterpreter(() => ({
				threadId: "mail",
				optionIds: [postmarkId, sesId],
				quote: message.text,
			})),
		);
		setup.failPersistenceAfter(2);
		await processMessage(setup, message);
		expect(setup.errors.length).toBeGreaterThan(0);
		expect(setup.durable.state.researchOffers ?? []).toEqual([]);
		expect(setup.publications.every(snapshot => !snapshot.researchOffers?.length)).toBe(true);
		setup.processor.stop();
	});
});
