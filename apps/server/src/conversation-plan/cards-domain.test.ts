import { describe, expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyCorrection, applyInference, restoreState } from "./domain";
import { applyEvent } from "./events";
import { base, mina, optionId, source, withOption } from "./cards-domain.test-fixtures";

describe("decision card thread authority", () => {
	test("new classifier and planner decisions cannot enter through inference", () => {
		let state = withOption();
		for (let origin of ["classifier", "planner"] as const) {
			let message = origin === "classifier" ? mina : {
				...mina,
				author: { kind: "agent" as const },
			};
			expect(() =>
				applyInference(state, {
					...base(`decision-${origin}`, 2, origin),
					type: "decision.recorded",
					source: source(message, "resolution"),
					text: "GitHub Apps",
					optionId,
					explicit: true,
				}, message)
			).toThrow("decisions are recorded on the card");
		}
	});

	test("new inferred reopenings and resolution candidates cannot bypass the card", () => {
		let decided = applyEvent(withOption(), {
			...base("old-decision", 2),
			type: "decision.recorded",
			source: source(mina, "resolution"),
			text: "GitHub Apps",
			optionId,
			explicit: true,
		});
		expect(() =>
			applyInference(decided, {
				...base("new-reopen", 3),
				type: "decision.reopened",
				source: source(mina, "reopening"),
				explicit: true,
			}, mina)
		).toThrow("decisions are recorded on the card");
		expect(() =>
			applyInference(withOption(), {
				...base("new-candidate", 2),
				type: "candidate.proposed",
				source: source(mina, "resolution"),
				candidate: { id: "candidate", kind: "resolution", text: "GitHub Apps" },
			}, mina)
		).toThrow("decisions are recorded on the card");
	});

	test("human and Planner options enter without a chat quote", () => {
		let state = applyEvent(withOption(), {
			...base("human-option", 2, "human"),
			type: "option.added",
			contribution: {
				id: "01K0N4W3B7P27CBAEC7A8C8WEB",
				text: "Build our own",
				authoring: "human-edited",
			},
		});
		state = applyEvent(state, {
			...base("planner-option", 3, "planner"),
			type: "option.added",
			contribution: {
				id: "01K0N4W3B7P27CBAEC7A8C8WEC",
				text: "Use an identity provider",
				authoring: "scribe",
			},
		});
		expect(state.threads[0].contributions.slice(-2)).toMatchObject([
			{ actor: { kind: "member", handle: "mina" }, sources: [] },
			{ actor: { kind: "agent" }, sources: [] },
		]);
		expect(restoreState(JSON.parse(JSON.stringify(state))).threads).toEqual(state.threads);
	});

	test("source-free card options enforce ULIDs and origin-specific wording", () => {
		let valid = {
			...base("card-option", 2, "human"),
			type: "option.added",
			contribution: {
				id: "01K0N4W3B7P27CBAEC7A8C8WEB",
				text: "Build our own",
				authoring: "human-edited",
			},
		} as const satisfies ConversationPlan.Event;
		let state = withOption();
		expect(() =>
			applyEvent(state, {
				...valid,
				contribution: { ...valid.contribution, id: "not-a-ulid" },
			})
		).toThrow("card option IDs must be ULIDs");
		expect(() =>
			applyEvent(state, {
				...valid,
				contribution: { ...valid.contribution, authoring: "quoted" },
			})
		).toThrow("card option authoring disagrees with origin");
		expect(() =>
			applyEvent(state, {
				...valid,
				...base("planner-incorrect", 2, "planner"),
			})
		).toThrow("card option authoring disagrees with origin");
		expect(() =>
			applyEvent(state, {
				...valid,
				...base("planner-bad-id", 2, "planner"),
				contribution: { ...valid.contribution, id: "not-a-ulid", authoring: "scribe" },
			})
		).toThrow("card option IDs must be ULIDs");
		expect(() =>
			applyEvent(state, {
				...valid,
				...base("card:planner-option:source", 2, "planner"),
				source: source({ ...mina, author: { kind: "agent" } }, "option"),
			})
		).toThrow("only card options can omit a source");
		expect(() =>
			applyEvent(state, {
				...valid,
				source: source(mina, "option"),
			})
		).toThrow("human action cannot claim a message quote");
	});

	test("old correction actions cannot change a linked card's decision or status", () => {
		let state = applyEvent(withOption(), {
			...base("link", 2),
			type: "card.linked",
			questionnaireId: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		});
		let correct = (change: ConversationPlan.CorrectionChange, current = state) =>
			applyCorrection(
				current,
				{
					actionId: `correction-${change.kind}`,
					threadId: "t1",
					expectedVersion: current.threads[0].version,
					change,
				},
				{ kind: "member", handle: "mina" },
				4,
			);
		expect(() => correct({ kind: "record-decision", text: "GitHub Apps", optionId }))
			.toThrow("decisions are recorded on the card");
		let decided = applyEvent(state, {
			...base("card-decision", 3, "human"),
			type: "decision.recorded",
			text: "GitHub Apps",
			optionId,
			explicit: true,
		});
		expect(() => correct({ kind: "set-status", status: "reopened" }, decided))
			.toThrow("decisions are recorded on the card");
		expect(() => correct({ kind: "edit", field: "decision", text: "Other choice" }, decided))
			.toThrow("decisions are recorded on the card");
		let candidate = applyInference(decided, {
			...base("reopening-candidate", 4),
			type: "candidate.proposed",
			source: source(mina, "reopening"),
			candidate: { id: "reopen", kind: "reopening", text: "Reopen this" },
		}, mina);
		expect(() => correct({ kind: "confirm-candidate", candidateId: "reopen" }, candidate))
			.toThrow("decisions are recorded on the card");
	});
});
