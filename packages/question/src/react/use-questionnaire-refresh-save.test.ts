import { describe, expect, it } from "bun:test";
import { addOption as grow, create, decision } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";
import { OFFLINE } from "./questionnaire-controller";
import { DEFINITION } from "./use-questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks, wrappers only.
describe("QuestionnaireController refresh-save", () => {
	it("saves after replayed selections settle even when an older edit never answers", async () => {
		let handlers = new Map<string, Set<(event: never) => void>>();
		let definition = decision(DEFINITION);
		let model = create(definition);
		let opens = 0;
		let edits: Array<{ resolve: (reply: unknown) => void }> = [];
		let submits: number[] = [];
		let wire = {
			ask(kind: string, payload: Record<string, unknown>) {
				if (kind === "question:open") {
					opens++;
					return Promise.resolve({
						open: true,
						definition,
						model: [...model.toBinary()],
						revision: opens - 1,
						presence: [],
					});
				}
				if (kind === "question:edit") {
					return new Promise(resolve => edits.push({ resolve }));
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
		await Bun.sleep(0);
		controller.change("q0", { choice: "o1" });
		controller.submit();
		await Bun.sleep(0);
		expect(edits).toHaveLength(1);
		off();
		await Bun.sleep(0);

		let grown = grow(definition, model, "o9", "Roll our own");
		if (!grown.ok) throw new Error("setup");
		definition = grown.definition;
		model = grown.model;
		for (let handler of handlers.get("question:changed") ?? []) {
			handler({ id: "w", definition, revision: 1 } as never);
		}
		await Bun.sleep(0);
		expect(opens).toBe(2);
		expect(edits).toHaveLength(2);
		expect(controller.getSnapshot().drafts.q0?.choice).toBe("o1");
		let remount = controller.subscribe(() => {});
		expect(opens).toBe(2);

		// Only the new generation answers. The first edit remains in flight forever.
		edits[1]!.resolve({ open: true, accepted: true, revision: 2 });
		await Bun.sleep(0);
		expect(edits).toHaveLength(3);
		edits[2]!.resolve({ open: true, accepted: true, revision: 3 });
		await Bun.sleep(0);
		expect(submits).toEqual([3]);
		edits[0]!.resolve({ open: true, accepted: true, revision: 99 });
		await Bun.sleep(0);
		expect(submits).toEqual([3]);
		for (let handler of handlers.get("question:resolved") ?? []) handler({ id: "w" } as never);
		expect(controller.getSnapshot().submitting).toBe(false);
		remount();
	});

	it("releases Save if connection drops while the replacement open is pending", async () => {
		let handlers = new Map<string, Set<(event: never) => void>>();
		let opens = 0;
		let wire = {
			ask(kind: string) {
				if (kind === "question:open") {
					opens++;
					return opens === 1
						? Promise.resolve({
							open: true,
							definition: DEFINITION,
							model: [...create(DEFINITION).toBinary()],
							revision: 0,
							presence: [],
						})
						: new Promise(() => {});
				}
				if (kind === "question:edit") return new Promise(() => {});
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
		for (let handler of handlers.get("question:changed") ?? []) {
			handler({ id: "w", definition: DEFINITION, revision: 1 } as never);
		}
		await Bun.sleep(0);
		expect(opens).toBe(2);
		off();
		await Bun.sleep(0);
		controller.configure(DEFINITION, false);
		await Bun.sleep(0);
		expect(controller.getSnapshot().submitting).toBe(false);
		// A dropped connection says so, rather than sounding like a refusal.
		expect(controller.getSnapshot().error).toBe(OFFLINE);
	});
});
