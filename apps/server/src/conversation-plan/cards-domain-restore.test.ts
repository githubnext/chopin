import { describe, expect, test } from "bun:test";
import type { Chat } from "@chopin/protocol";
import { applyInference, initialState, replay, restoreState } from "./domain";
import { applyEvent } from "./events";
import { base, jules, mina, optionId, source, withOption } from "./cards-domain.test-fixtures";

describe("decision card thread authority", () => {
	test("a thread links one decision card and restores that link", () => {
		let state = applyEvent(withOption(), {
			...base("link", 2),
			type: "card.linked",
			questionnaireId: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		});
		expect(state.threads[0].questionnaireId).toBe("01K0N4TR8K7JGM4R1J7PW4R8YJ");
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
		expect(() =>
			applyEvent(state, {
				...base("second-link", 3),
				type: "card.linked",
				questionnaireId: "01K0N4TR8K7JGM4R1J7PW4R8YK",
			})
		).toThrow("thread already has a card");
	});

	test("a card decision clears the proposal, and a person can discard its thread", () => {
		let state = applyInference(withOption(), {
			...base("settle", 2),
			type: "settle.suggested",
			source: source(mina, "resolution"),
			optionId,
		}, mina);
		state = applyEvent(state, {
			...base("card-decision", 3, "human"),
			type: "decision.recorded",
			text: "GitHub Apps",
			optionId,
			explicit: true,
		});
		expect(state.threads[0].pendingSettle).toBeUndefined();
		state = applyEvent(state, {
			...base("card-discard", 4, "human"),
			type: "thread.discarded",
		});
		expect(state.threads[0].status).toBe("discarded");
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
	});

	test("sourced Planner chat contributions still apply and restore", () => {
		let optionMessage: Chat.Entry = {
			id: "agent-option",
			author: { kind: "agent" },
			text: "Use a managed identity provider",
			ts: 4,
		};
		let reasonMessage: Chat.Entry = {
			...optionMessage,
			id: "agent-reason",
			text: "It handles account recovery",
		};
		let state = applyInference(withOption(), {
			...base("classifier:0123456789abcdef01234567", 2, "planner"),
			type: "option.added",
			source: source(optionMessage, "option"),
			contribution: {
				id: "classifier:89abcdef0123456789abcdef",
				text: optionMessage.text,
				authoring: "quoted",
			},
		}, optionMessage);
		state = applyInference(state, {
			...base("classifier:fedcba9876543210fedcba98", 3, "planner"),
			type: "reason.added",
			source: source(reasonMessage, "reason"),
			contribution: {
				id: "classifier:76543210fedcba9876543210",
				text: reasonMessage.text,
				authoring: "quoted",
				targetId: optionId,
			},
		}, reasonMessage);
		expect(state.threads[0].contributions.slice(-2).map((item) => item.kind)).toEqual([
			"option",
			"reason",
		]);
		let saved = JSON.parse(JSON.stringify(state));
		let quotedOption: Chat.Entry = { ...jules, id: "option-message", text: "GitHub Apps" };
		expect(restoreState(saved, [jules, quotedOption, optionMessage, reasonMessage]).threads)
			.toEqual(saved.threads);
		expect(() =>
			applyInference(state, {
				...base("classifier:111111111111111111111111", 4, "planner"),
				type: "option.added",
				source: source(optionMessage, "option"),
				contribution: {
					id: "classifier:222222222222222222222222",
					text: optionMessage.text,
					authoring: "human-edited",
				},
			}, optionMessage)
		).toThrow("inference cannot claim human wording");
	});

	test("historical classifier decisions still replay and restore", () => {
		let state = applyEvent(withOption(), {
			...base("historic-decision", 2),
			type: "decision.recorded",
			source: source(mina, "resolution"),
			text: "GitHub Apps",
			optionId,
			explicit: true,
		});
		state = applyEvent(state, {
			...base("historic-reopen", 3),
			type: "decision.reopened",
			source: source(mina, "reopening"),
			explicit: true,
		});
		let saved = JSON.parse(JSON.stringify(state));
		expect(replay(saved.events).threads).toEqual(saved.threads);
		let quotedOption: Chat.Entry = { ...jules, id: "option-message", text: "GitHub Apps" };
		expect(restoreState(saved, [jules, quotedOption, mina]).threads).toEqual(saved.threads);
		expect(state.threads[0].decisionHistory).toHaveLength(1);
	});

	test("restore rejects tampered card links, proposals, and malformed new events", () => {
		let state = applyEvent(withOption(), {
			...base("link", 2),
			type: "card.linked",
			questionnaireId: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		});
		state = applyInference(state, {
			...base("settle", 3),
			type: "settle.suggested",
			source: source(mina, "resolution"),
			optionId,
		}, mina);
		let saved = JSON.parse(JSON.stringify(state));
		let wrongLink = structuredClone(saved);
		wrongLink.threads[0].questionnaireId = "other-card";
		expect(() => restoreState(wrongLink)).toThrow(/snapshot/i);
		let wrongProposal = structuredClone(saved);
		wrongProposal.threads[0].pendingSettle.optionId = "other-option";
		expect(() => restoreState(wrongProposal)).toThrow(/snapshot/i);
		let malformedEvent = structuredClone(saved);
		malformedEvent.events[2].source = source(mina, "resolution");
		expect(() => restoreState(malformedEvent)).toThrow(/unknown/i);
		expect(() =>
			applyEvent(state, {
				...base("forged-discard", 4),
				type: "thread.discarded",
			})
		).toThrow("only a person discards");
	});

	test("the thread limit allows twenty and rejects a twenty-first", () => {
		let state = initialState();
		for (let index = 0; index < 20; index++) {
			let message = { ...jules, id: `question-${index}` };
			state = applyInference(state, {
				...base(`open-${index}`, 0),
				threadId: `thread-${index}`,
				type: "thread.opened",
				source: source(message, "question"),
				question: message.text,
			}, message);
		}
		expect(state.threads).toHaveLength(20);
		let message = { ...jules, id: "question-20" };
		expect(() =>
			applyInference(state, {
				...base("open-20", 0),
				threadId: "thread-20",
				type: "thread.opened",
				source: source(message, "question"),
				question: message.text,
			}, message)
		).toThrow("conversation thread limit reached");
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
	});
});
