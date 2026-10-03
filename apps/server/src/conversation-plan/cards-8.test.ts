import { expect, test } from "bun:test";

import { restoreState } from "./domain";

import { OPTION, scopedNoticeFixture } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("optionless non-support refreshes only the active supporter's scoped notice", async () => {
	let fixture = await scopedNoticeFixture(true);
	let before = fixture.context.plan.chat.entries.find(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	if (!before) throw new Error("scoped notice missing");
	let quote = "I don't support that choice anymore.";
	await fixture.deliver({
		id: "rob-optionless-opposition",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: fixture.state().threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 4,
		source: {
			messageId: "scoped-rob-optionless",
			author: { kind: "member", handle: "rob" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		position: "oppose",
	});
	let notices = fixture.context.plan.chat.entries.filter(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.id).toBe(before.id);
	expect(notices[0]?.decision).toMatchObject({ sources: [fixture.proposal.source] });
	expect(fixture.state().events.at(-1)?.id).toBe("rob-optionless-opposition");
	expect(fixture.errors).toEqual([]);
});

test("optionless proposer non-support retires a scoped Save with no other support", async () => {
	let fixture = await scopedNoticeFixture(false);
	let quote = "I don't support that choice anymore.";
	await fixture.deliver({
		id: "mei-optionless-opposition",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: fixture.state().threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: {
			messageId: "scoped-mei-optionless",
			author: { kind: "member", handle: "mei" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		position: "oppose",
	});
	let notices = fixture.context.plan.chat.entries.filter(entry =>
		entry.decision?.kind === "scoped-choice"
	);
	expect(notices.length === 0 || !fixture.state().threads[0]?.pendingScopedChoice).toBe(true);
	expect(fixture.state().events.at(-1)?.id).toBe("mei-optionless-opposition");
	expect(fixture.errors).toEqual([]);
});

test("legacy persisted optionless withdrawal still retires scoped Save on replay", async () => {
	let fixture = await scopedNoticeFixture(false);
	let quote = "I don't support that choice anymore.";
	await fixture.deliver({
		id: "mei-legacy-withdrawal",
		type: "stance.changed",
		scopedProposalId: fixture.proposal.id,
		threadId: "thread-a",
		observedThreadVersion: fixture.state().threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: {
			messageId: "scoped-mei-legacy",
			author: { kind: "member", handle: "mei" },
			quote,
			start: 0,
			end: quote.length,
			role: "objection",
		},
		position: "oppose",
	});
	let stored = structuredClone(fixture.state());
	let legacy = stored.events.at(-1);
	if (!legacy || legacy.type !== "stance.changed") throw new Error("withdrawal missing");
	delete legacy.scopedProposalId;
	let restored = restoreState(stored, fixture.context.plan.chat.entries);
	expect(restored.events.at(-1)).not.toHaveProperty("scopedProposalId");
	expect(restored.threads[0]?.pendingScopedChoice).toBeUndefined();
});

for (
	let scenario of [
		{
			name: "an unrelated optionless objection by a supporter keeps scoped evidence",
			supporter: true,
			id: "rob-toolbar-objection",
			messageId: "scoped-rob-toolbar",
			actor: "rob",
			quote: "I oppose making the toolbar blue.",
			at: 4,
			optionId: undefined,
		},
		{
			name: "an unrelated optionless objection by the proposer keeps scoped Save active",
			supporter: false,
			id: "mei-toolbar-objection",
			messageId: "scoped-mei-toolbar",
			actor: "mei",
			quote: "I oppose making the toolbar blue.",
			at: 3,
			optionId: undefined,
		},
		{
			name: "an unlinked named-option objection keeps the scoped Save notice active",
			supporter: false,
			id: "mei-unlinked-named-objection",
			messageId: "scoped-mei-unlinked-named",
			actor: "mei",
			quote: "I oppose GitHub Apps.",
			at: 3,
			optionId: OPTION,
		},
	]
) {
	test(scenario.name, async () => {
		let fixture = await scopedNoticeFixture(scenario.supporter);
		let before = fixture.context.plan.chat.entries.find(entry =>
			entry.decision?.kind === "scoped-choice"
		);
		if (!before) throw new Error("scoped notice missing");
		let previous = structuredClone(before.decision);
		await fixture.deliver({
			id: scenario.id,
			type: "stance.changed",
			scopedProposalId: null,
			threadId: "thread-a",
			observedThreadVersion: fixture.state().threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: scenario.at,
			source: {
				messageId: scenario.messageId,
				author: { kind: "member", handle: scenario.actor },
				quote: scenario.quote,
				start: 0,
				end: scenario.quote.length,
				role: "objection",
			},
			...(scenario.optionId ? { optionId: scenario.optionId } : {}),
			position: "oppose",
		});
		expect(fixture.state().threads[0]?.pendingScopedChoice?.proposalId)
			.toBe(fixture.proposal.id);
		expect(fixture.context.plan.chat.entries.find(entry => entry.id === before.id)?.decision)
			.toEqual(previous);
		expect(fixture.errors).toEqual([]);
	});
}
