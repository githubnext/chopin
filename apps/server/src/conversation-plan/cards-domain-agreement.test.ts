import { describe, expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference, replay, restoreState } from "./domain";
import { applyEvent } from "./events";
import {
	base,
	julesAgrees,
	mina,
	optionId,
	source,
	withOption,
	withPendingSettle,
} from "./cards-domain.test-fixtures";

describe("settle agreement authority", () => {
	test("another member can agree with the pending option without deciding it", () => {
		let state = applyInference(withPendingSettle(), {
			...base("agree", 3),
			type: "settle.agreed",
			source: source(julesAgrees, "support"),
			optionId,
		}, julesAgrees);
		expect(state.events.at(-1)?.type).toBe("settle.agreed");
		expect(state.threads[0]).toMatchObject({
			status: "exploring",
			version: 4,
			pendingSettle: { optionId, proposer: "mina" },
		});
		expect(state.threads[0].decision).toBeUndefined();
		expect(replay(state.events).threads).toEqual(state.threads);
	});

	test("agreement requires another member and exactly the pending option", () => {
		let self: Chat.Entry = {
			...julesAgrees,
			id: "m4",
			author: { kind: "member", handle: "mina" },
		};
		expect(() =>
			applyInference(withPendingSettle(), {
				...base("self", 3),
				type: "settle.agreed",
				source: source(self, "support"),
				optionId,
			}, self)
		).toThrow("agreement needs another member");
		expect(() =>
			applyInference(withPendingSettle(), {
				...base("different", 3),
				type: "settle.agreed",
				source: source(julesAgrees, "support"),
				optionId: "other-option",
			}, julesAgrees)
		).toThrow("agreement names another option");
		expect(() =>
			applyInference(withOption(), {
				...base("no-proposal", 2),
				type: "settle.agreed",
				source: source(julesAgrees, "support"),
				optionId,
			}, julesAgrees)
		).toThrow("no pending proposal to settle");
	});

	test("agreement stays classifier-sourced support by a real member", () => {
		let state = withPendingSettle();
		expect(() =>
			applyInference(state, {
				...base("human-agree", 3, "human"),
				type: "settle.agreed",
				source: source(julesAgrees, "support"),
				optionId,
			}, julesAgrees)
		).toThrow("human events require authenticated correction");
		expect(() =>
			applyInference(state, {
				...base("planner-agree", 3, "planner"),
				type: "settle.agreed",
				source: source(julesAgrees, "support"),
				optionId,
			}, julesAgrees)
		).toThrow("agreement is inferred");
		expect(() =>
			applyInference(state, {
				...base("objection-agree", 3),
				type: "settle.agreed",
				source: source(julesAgrees, "objection"),
				optionId,
			}, julesAgrees)
		).toThrow("agreement source role disagrees");
		let agent: Chat.Entry = {
			...julesAgrees,
			id: "agent-agree",
			author: { kind: "agent" },
		};
		expect(() =>
			applyInference(state, {
				...base("agent-agree", 3),
				type: "settle.agreed",
				source: source(agent, "support"),
				optionId,
			}, agent)
		).toThrow("agreement needs another member");
	});
});

describe("decision card thread authority", () => {
	test("a settle proposal records its human proposer without deciding", () => {
		let state = applyInference(withOption(), {
			...base("settle", 2),
			type: "settle.suggested",
			source: source(mina, "resolution"),
			optionId,
		}, mina);
		expect(state.threads[0].pendingSettle).toEqual({
			optionId,
			proposer: "mina",
			messageId: "m2",
		});
		expect(state.threads[0].status).toBe("exploring");
		expect(state.threads[0].decision).toBeUndefined();
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
	});

	test("a spike agreement binds the current accepted proposal without deciding", () => {
		let cardId = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
		let state = withOption();
		state = applyEvent(state, {
			...base("link-spike", state.threads[0]!.version),
			type: "card.linked",
			questionnaireId: cardId,
		});
		let mei: Chat.Entry = {
			id: "mei-spike",
			author: { kind: "member", handle: "mei" },
			text: "I'd pick GitHub Apps for the spike;",
			ts: 4,
		};
		let proposal: ConversationPlan.Event = {
			...base("spike-proposal", state.threads[0]!.version),
			type: "scoped-choice.proposed",
			source: source(mei, "support"),
			cardId,
			optionId,
			label: "GitHub Apps",
			scope: "spike",
		};
		state = applyInference(state, proposal, mei);
		let rob: Chat.Entry = {
			id: "rob-spike",
			author: { kind: "member", handle: "rob" },
			text: "yep, GitHub Apps for the spike.",
			ts: 5,
		};
		let agreement: ConversationPlan.Event = {
			...base("spike-agreement", state.threads[0]!.version),
			type: "scoped-choice.agreed",
			source: source(rob, "support"),
			proposalId: proposal.id,
			cardId,
			optionId,
			label: "GitHub Apps",
			scope: "spike",
		};
		expect(() => applyInference(state, { ...agreement, proposalId: "prior-proposal" }, rob))
			.toThrow("scoped choice agreement does not match the current proposal");
		let agreed = applyInference(state, agreement, rob);
		expect(agreed.events.at(-1)).toMatchObject({
			type: "scoped-choice.agreed",
			proposalId: proposal.id,
		});
		expect(agreed.threads[0]?.pendingScopedChoice?.proposalId).toBe(proposal.id);
		expect(agreed.threads[0]?.pendingSettle).toBeUndefined();
		expect(agreed.threads[0]?.decision).toBeUndefined();
		expect(restoreState(JSON.parse(JSON.stringify(agreed))).threads).toEqual(agreed.threads);
	});

	test("settle proposals need a known option and a member's resolution quote", () => {
		let state = withOption();
		let valid = {
			...base("settle", 2),
			type: "settle.suggested" as const,
			source: source(mina, "resolution"),
			optionId,
		};
		expect(() =>
			applyInference(state, {
				...valid,
				optionId: "unknown",
			}, mina)
		).toThrow("unknown settle option");
		let agent: Chat.Entry = { ...mina, author: { kind: "agent" } };
		expect(() =>
			applyInference(state, {
				...valid,
				source: source(agent, "resolution"),
			}, agent)
		).toThrow("human member required to settle");
		expect(() =>
			applyInference(state, {
				...valid,
				source: source(mina, "option"),
			}, mina)
		).toThrow("settle source role disagrees");
		let decided = applyEvent(state, {
			...base("card-decision", 2, "human"),
			type: "decision.recorded",
			text: "GitHub Apps",
			optionId,
			explicit: true,
		});
		expect(() => applyInference(decided, { ...valid, observedThreadVersion: 3 }, mina))
			.toThrow("thread is not open for settling");
	});
});
