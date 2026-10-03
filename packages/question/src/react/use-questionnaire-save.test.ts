import { describe, expect, it } from "bun:test";
import { create } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";
import { DEFINITION, QUESTIONNAIRE, transport } from "./use-questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks, wrappers only.
describe("QuestionnaireController save", () => {
	it("opens an older multi-question card with its complete shared draft", async () => {
		let bridge = transport(QUESTIONNAIRE);
		let controller = new QuestionnaireController(
			bridge.value,
			"question-1",
			QUESTIONNAIRE,
			true,
		);
		let off = controller.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(controller.getSnapshot().error).toBeUndefined();
		expect(controller.getSnapshot().drafts.q0).toBeDefined();
		expect(controller.getSnapshot().drafts.q1).toBeDefined();
		expect(bridge.submits()).toBe(0);
		off();
	});

	it("finishes an explicit Save after its last view unmounts", async () => {
		let model = create(DEFINITION);
		let settleEdit!: (reply: unknown) => void;
		let submits: number[] = [];
		let handlers = new Map<string, Set<(event: never) => void>>();
		let wire = {
			ask(kind: string, payload: Record<string, unknown>) {
				if (kind === "question:open") {
					return Promise.resolve({
						open: true,
						definition: DEFINITION,
						model: [...model.toBinary()],
						revision: 0,
						presence: [],
					});
				}
				if (kind === "question:edit") {
					return new Promise(resolve => settleEdit = resolve);
				}
				if (kind === "question:submit") {
					submits.push(payload.revision as number);
					return Promise.resolve({ ok: true });
				}
				throw new Error(`Unexpected ${kind}`);
			},
			send() {},
			on(kind: string, handler: (event: never) => void) {
				let set = handlers.get(kind) ?? new Set();
				handlers.set(kind, set);
				set.add(handler);
				return () => set.delete(handler);
			},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		controller.change("q0", { choice: "o0" });
		controller.submit();
		await Bun.sleep(0);
		off();
		await Bun.sleep(0);
		settleEdit({ open: true, accepted: true, revision: 1 });
		await Bun.sleep(0);
		expect(submits).toEqual([1]);
		expect(controller.getSnapshot().error).toBeUndefined();
		for (let handler of handlers.get("question:resolved") ?? []) handler({ id: "w" } as never);
		expect([...handlers.values()].every(set => set.size === 0)).toBe(true);
	});

	it("saves only the visible suggestion snapshot and rejects a moved or cleared one", async () => {
		let current = transport();
		current.setSuggestion({ optionId: "o0", revision: 3 });
		let accepted = new QuestionnaireController(current.value, "question-1", DEFINITION, true);
		let offAccepted = accepted.subscribe(() => {});
		await Bun.sleep(0);
		accepted.submit({ optionId: "o0", revision: 3 });
		await Bun.sleep(0);
		expect(current.submitPayloads()).toEqual([{
			id: "question-1",
			revision: 3,
			suggestedOptionId: "o0",
		}]);
		offAccepted();

		let moved = transport();
		moved.setSuggestion({ optionId: "o0", revision: 3 });
		let stale = new QuestionnaireController(moved.value, "question-1", DEFINITION, true);
		let offStale = stale.subscribe(() => {});
		await Bun.sleep(0);
		moved.setSuggestion({ optionId: "o0", revision: 4 });
		stale.submit({ optionId: "o0", revision: 3 });
		await Bun.sleep(0);
		expect(moved.submitPayloads()).toEqual([{
			id: "question-1",
			revision: 3,
			suggestedOptionId: "o0",
		}]);
		expect(stale.getSnapshot().submitting).toBe(false);
		offStale();

		let cleared = transport();
		cleared.setSuggestion({ optionId: "o0", revision: 3 });
		let old = new QuestionnaireController(cleared.value, "question-1", DEFINITION, true);
		let offOld = old.subscribe(() => {});
		await Bun.sleep(0);
		cleared.setSuggestion(undefined);
		old.submit({ optionId: "o0", revision: 3 });
		await Bun.sleep(0);
		expect(cleared.submitPayloads()).toEqual([{
			id: "question-1",
			revision: 3,
			suggestedOptionId: "o0",
		}]);
		expect(old.getSnapshot().submitting).toBe(false);
		offOld();
	});

	it("a queued human choice ignores an older visible suggestion", async () => {
		let bridge = transport();
		bridge.setSuggestion({ optionId: "o0", revision: 3 });
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		controller.change("q0", { choice: "o0" });
		controller.submit({ optionId: "o0", revision: 3 });
		await Bun.sleep(0);
		expect(bridge.submitPayloads()).toEqual([{ id: "question-1", revision: 4 }]);
		off();
	});
});
