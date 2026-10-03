import { describe, expect, test } from "bun:test";
import { applyEvent } from "./events";
import type { JevAnswer } from "./jev";
import { renderResearchTask } from "./validation";
import {
	d03Options,
	d04Options,
	entry,
	exactSource,
	expectNoDurableOffer,
	harness,
	inputInterpreter,
	postmarkCopyId,
	postmarkId,
	processMessage,
	r2Id,
	relayCopyId,
	relayId,
	resendId,
	s3Id,
	seededThread,
	sesCopyId,
	sesId,
	sharedDiskId,
} from "./research-offer-detection.test-fixtures";
import type { ResearchJudgment } from "./research-offer-detection.test-fixtures";

// Whole archived callbacks; only suite wrappers and imports change.
describe("proactive current-cost research offers", () => {
	test("three- and four-option concern admission fails closed on weak or stale evidence", async () => {
		let state = d03Options();
		let generic = entry("weak-three-option", "I don't know current provider prices.", 11);
		let ids = [relayId, postmarkId, sesId];
		let base: ResearchJudgment = {
			threadId: "mail",
			optionIds: ids,
			quote: generic.text,
			kind: "current-cost-concern",
			scopeChoice: "all-current",
		};
		let fourOptions = seededThread("four-providers", "Which mail provider?", [
			{ id: relayId, text: "SMTP relay" },
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
			{ id: resendId, text: "Resend" },
		]);
		let fourOptionMessage = entry(
			"four-option-price-need",
			"I don't know current provider prices.",
			11,
		);
		let fourOptionJudgment: ResearchJudgment = {
			threadId: "four-providers",
			optionIds: [relayId, postmarkId, sesId, resendId],
			quote: fourOptionMessage.text,
			kind: "current-cost-concern",
			scopeChoice: "all-current",
		};
		let fourOptionSetup = harness(
			fourOptions,
			inputInterpreter(() => fourOptionJudgment),
		);
		await processMessage(fourOptionSetup, fourOptionMessage);
		let fourOptionOffer = fourOptionSetup.durable.state.researchOffers?.[0];
		expect(fourOptionOffer).toMatchObject({
			status: "offered",
			source: exactSource(fourOptionMessage, fourOptionMessage.text),
			task: {
				kind: "current-cost-concern",
				options: [
					{ id: relayId, labelAtOffer: "SMTP relay" },
					{ id: postmarkId, labelAtOffer: "Postmark" },
					{ id: sesId, labelAtOffer: "Amazon SES" },
					{ id: resendId, labelAtOffer: "Resend" },
				],
			},
		});
		expect(fourOptionOffer?.brief).toBe(
			renderResearchTask(fourOptionOffer!.task!, fourOptionOffer!.source),
		);
		expect(fourOptionSetup.durable.pending).toEqual([]);
		expect(fourOptionSetup.durable.receipts).toEqual([]);
		fourOptionSetup.processor.stop();

		await expectNoDurableOffer(state, generic, { ...base, triageOwned: 0.1 });
		await expectNoDurableOffer(state, generic, { ...base, owned: 0.1 });
		await expectNoDurableOffer(state, generic, { ...base, answered: 0.95 });

		let quoted = entry(
			"quoted-three-option",
			"Mina asked, ‘I don't know current provider prices.’",
			12,
		);
		await expectNoDurableOffer(state, quoted, {
			...base,
			quoteChoice: "none",
		});
		let reported = entry(
			"reported-three-option",
			"Mina reported uncertainty about provider prices.",
			13,
		);
		await expectNoDurableOffer(state, reported, {
			...base,
			quoteChoice: "none",
		});
		let conditional = entry(
			"conditional-three-option",
			"If prices are unclear, we could research later.",
			14,
		);
		await expectNoDurableOffer(state, conditional, {
			...base,
			quoteChoice: "none",
		});

		let weakThread: JevAnswer = {
			type: "choice",
			choice: "none",
			confidence: 0.7,
			probabilities: { mail: 0.6, none: 0.4 },
		};
		await expectNoDurableOffer(state, generic, { ...base, threadAnswer: weakThread });

		let ambiguous = d03Options();
		ambiguous = applyEvent(ambiguous, {
			id: "open-mail-copy",
			type: "thread.opened",
			threadId: "mail-copy",
			observedThreadVersion: 0,
			origin: "planner",
			actor: { kind: "agent" },
			at: ambiguous.events.length + 1,
			question: "Which provider should handle email delivery?",
		});
		for (let [index, id] of [relayCopyId, postmarkCopyId, sesCopyId].entries()) {
			ambiguous = applyEvent(ambiguous, {
				id: `copy-option-${id}`,
				type: "option.added",
				threadId: "mail-copy",
				observedThreadVersion: ambiguous.threads.at(-1)!.version,
				origin: "planner",
				actor: { kind: "agent" },
				at: ambiguous.events.length + 1,
				contribution: {
					id,
					text: ["SMTP relay", "Postmark", "Amazon SES"][index]!,
					authoring: "scribe",
				},
			});
		}
		ambiguous = applyEvent(ambiguous, {
			id: "link-mail-copy",
			type: "card.linked",
			threadId: "mail-copy",
			observedThreadVersion: ambiguous.threads.at(-1)!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: ambiguous.events.length + 1,
			questionnaireId: "card-mail-copy",
		});
		await expectNoDurableOffer(ambiguous, generic, base);

		let five = seededThread("five-providers", "Which mail provider?", [
			{ id: relayId, text: "SMTP relay" },
			{ id: postmarkId, text: "Postmark" },
			{ id: sesId, text: "Amazon SES" },
			{ id: resendId, text: "Resend" },
			{ id: sharedDiskId, text: "Mailgun" },
		]);
		await expectNoDurableOffer(five, generic, {
			...base,
			threadId: "five-providers",
			optionIds: [relayId, postmarkId, sesId, resendId, sharedDiskId],
		});

		let storage = d04Options();
		storage = applyEvent(storage, {
			id: "rename-r2-before-cost-concern",
			type: "option.relabeled",
			threadId: "storage",
			observedThreadVersion: storage.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 10,
			optionId: r2Id,
			label: "Backblaze B2",
			observedCardRevision: 0,
		});
		let stale = entry("stale-three-option", "R2's egress could matter for thumbnails.", 11);
		await expectNoDurableOffer(storage, stale, {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: stale.text,
			kind: "current-cost-concern",
			scopeChoice: r2Id,
		});

		let foreign = applyEvent(d04Options(), {
			id: "open-foreign-option-thread",
			type: "thread.opened",
			threadId: "other",
			observedThreadVersion: 0,
			origin: "planner",
			actor: { kind: "agent" },
			at: 10,
			question: "Which queue?",
		});
		foreign = applyEvent(foreign, {
			id: "add-foreign-option",
			type: "option.added",
			threadId: "other",
			observedThreadVersion: foreign.threads[1]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 11,
			contribution: { id: resendId, text: "Resend", authoring: "scribe" },
		});
		let egress = entry("foreign-focus", "R2's egress could matter for thumbnails.", 12);
		await expectNoDurableOffer(foreign, egress, {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: egress.text,
			kind: "current-cost-concern",
			scopeAnswer: {
				type: "choice",
				choice: resendId,
				confidence: 0.95,
				probabilities: { [resendId]: 0.95, none: 0.05 },
			},
		});

		let multiName = entry(
			"multi-name-three-option",
			"R2's egress and Amazon S3 request prices could matter.",
			13,
		);
		await expectNoDurableOffer(d04Options(), multiName, {
			threadId: "storage",
			optionIds: [s3Id, sharedDiskId, r2Id],
			quote: multiName.text,
			kind: "current-cost-concern",
			scopeChoice: r2Id,
		});
		let explicitPair = entry(
			"explicit-pair-three-options",
			"Compare Amazon S3 and Cloudflare R2 costs.",
			14,
		);
		await expectNoDurableOffer(d04Options(), explicitPair, {
			threadId: "storage",
			optionIds: [s3Id, r2Id],
			quote: explicitPair.text,
			kind: "current-cost-comparison",
		});
	});
});
