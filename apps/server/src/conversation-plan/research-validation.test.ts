import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { assertResearchOfferShape, renderResearchTask, researchNamedOptionIds } from "./validation";

function legacy(): ConversationPlan.ResearchOffer {
	return {
		id: "offer-1",
		needId: "need-1",
		contextId: "context-1",
		source: {
			messageId: "message-1",
			author: { kind: "member", handle: "maggie" },
			quote: "Compare costs",
			start: 0,
			end: 13,
		},
		brief: "Compare costs",
		status: "offered",
	};
}

test("legacy research offers keep the exact source quote as their brief", () => {
	expect(() => assertResearchOfferShape(legacy())).not.toThrow();
	expect(() => assertResearchOfferShape({ ...legacy(), brief: "Compare prices" }))
		.toThrow("research brief must equal source quote");
});

function comparison(): ConversationPlan.ResearchTask {
	return {
		kind: "current-cost-comparison",
		threadId: "thread-1",
		observedEventCount: 2,
		observedThreadVersion: 1,
		options: [{ id: "r2", labelAtOffer: "Cloudflare R2" }, { id: "s3", labelAtOffer: "Amazon S3" }],
	};
}
function taskOffer(
	task: ConversationPlan.ResearchTask,
	quote = "Compare costs",
): ConversationPlan.ResearchOffer {
	let source = { ...legacy().source, quote, end: quote.length };
	return {
		...legacy(),
		source,
		threadId: "thread-1",
		task,
		brief: renderResearchTask(task, source),
	};
}

test("comparison and concern briefs use frozen labels and exact source context", () => {
	let pair = taskOffer(comparison());
	expect(pair.brief).toBe(
		"Compare current costs for Cloudflare R2 and Amazon S3. Discussion context: “Compare costs”",
	);
	expect(() => assertResearchOfferShape(pair)).not.toThrow();
	let concern: ConversationPlan.ResearchTask = {
		kind: "current-cost-concern",
		threadId: "thread-1",
		observedEventCount: 2,
		observedThreadVersion: 1,
		options: [
			{ id: "r2", labelAtOffer: "Cloudflare R2" },
			{ id: "s3", labelAtOffer: "Amazon S3" },
			{ id: "b2", labelAtOffer: "Backblaze B2" },
		],
	};
	let across = taskOffer(concern);
	expect(across.brief).toBe(
		"Investigate current costs across Cloudflare R2, Amazon S3, Backblaze B2. Discussion context: “Compare costs”",
	);
	expect(() => assertResearchOfferShape(across)).not.toThrow();
	let focused = taskOffer({ ...concern, focusOptionId: "r2" }, "R2 costs");
	expect(focused.brief).toBe(
		"Investigate current costs for Cloudflare R2; consider Amazon S3, Backblaze B2 as context. Discussion context: “R2 costs”",
	);
	expect(() => assertResearchOfferShape(focused)).not.toThrow();
	expect(() => assertResearchOfferShape({ ...focused, brief: focused.brief + " changed" })).toThrow(
		/brief must match/,
	);
	expect(() => assertResearchOfferShape(taskOffer({ ...concern, focusOptionId: "r2" }))).toThrow(
		/not grounded/,
	);
});

test("research provider codes resolve only unique bounded mentions", () => {
	let options = [{ id: "r2", labelAtOffer: "Cloudflare R2" }, {
		id: "s3",
		labelAtOffer: "Amazon S3",
	}];
	expect(researchNamedOptionIds("R2 costs", options)).toEqual(["r2"]);
	expect(researchNamedOptionIds("AR2B costs", options)).toEqual([]);
	expect(researchNamedOptionIds("R2 and S3 costs", options)).toEqual(["r2", "s3"]);
	expect(researchNamedOptionIds("R2", [...options, { id: "other", labelAtOffer: "Other R2" }]))
		.toEqual([]);
	expect(researchNamedOptionIds("R2", [{ id: "mixed", labelAtOffer: "R2 S3" }])).toEqual([]);
});

test("frozen research task fields, option identities, labels, and focus remain bounded", () => {
	let offer = taskOffer(comparison());
	for (
		let task of [
			{ ...comparison(), threadId: "other" },
			{ ...comparison(), observedEventCount: -1 },
			{ ...comparison(), focusOptionId: "r2" },
			{ ...comparison(), options: [{ id: "r2", labelAtOffer: "R2" }] },
			{
				...comparison(),
				options: [{ id: "r2", labelAtOffer: "R2" }, { id: "r2", labelAtOffer: "S3" }],
			},
			{
				...comparison(),
				options: [{ id: "r2", labelAtOffer: " R2" }, { id: "s3", labelAtOffer: "S3" }],
			},
			{
				...comparison(),
				options: [{ id: "r2", labelAtOffer: "x".repeat(161) }, { id: "s3", labelAtOffer: "S3" }],
			},
			{ ...comparison(), extra: true },
		]
	) expect(() => assertResearchOfferShape({ ...offer, task })).toThrow();
});

test("research status and action actors agree while unknown fields are rejected", () => {
	let action = {
		id: "action-1",
		kind: "research",
		actor: { kind: "member", handle: "maggie" },
		principalId: "principal-1",
		at: 1,
	};
	expect(() => assertResearchOfferShape({ ...legacy(), status: "accepted", action })).not.toThrow();
	expect(() =>
		assertResearchOfferShape({
			...legacy(),
			status: "dismissed",
			action: { ...action, kind: "dismiss" },
		})
	).not.toThrow();
	for (
		let offer of [
			{ ...legacy(), action },
			{ ...legacy(), status: "unknown" },
			{ ...legacy(), status: "accepted" },
			{ ...legacy(), status: "dismissed", action },
			{ ...legacy(), status: "accepted", action: { ...action, actor: { kind: "agent" } } },
			{ ...legacy(), status: "accepted", action: { ...action, at: -1 } },
			{ ...legacy(), source: { ...legacy().source, author: { kind: "agent" } } },
			{ ...legacy(), source: { ...legacy().source, role: "support" } },
			{ ...legacy(), extra: true },
		]
	) expect(() => assertResearchOfferShape(offer)).toThrow();
});
