import { describe, expect, it } from "bun:test";
import { addOption as grow, create, decision } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";
import { DEFINITION } from "./use-questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks, wrappers only.
describe("QuestionnaireController option-growth", () => {
	it("replays an in-flight selection after every reopen despite late older acknowledgements", async () => {
		let handlers = new Map<string, Set<(event: never) => void>>();
		let definition = decision(DEFINITION);
		let model = create(definition);
		let opens = 0;
		let edits: Array<{ patch: number[]; resolve: (reply: unknown) => void }> = [];
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
					return new Promise(resolve => {
						edits.push({ patch: payload.patch as number[], resolve });
					});
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
		let emitChanged = (revision: number) => {
			for (let handler of handlers.get("question:changed") ?? []) {
				handler({ id: "w", definition, revision } as never);
			}
		};
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		controller.change("q0", { choice: "o0" });
		await Bun.sleep(0);
		expect(edits).toHaveLength(1);
		controller.change("q0", { choice: "o1" });
		await Bun.sleep(0);
		expect(edits).toHaveLength(1);

		let first = grow(definition, model, "o9", "Roll our own");
		if (!first.ok) throw new Error("setup");
		definition = first.definition;
		model = first.model;
		emitChanged(1);
		await Bun.sleep(10);
		expect(opens).toBe(2);
		expect(edits).toHaveLength(2);
		expect(controller.getSnapshot().definition?.questions[0].options.map(option => option.id))
			.toContain("o9");
		expect(controller.getSnapshot().drafts.q0?.choice).toBe("o1");

		// An acknowledgement from the abandoned generation cannot remove the
		// selection that the new generation still needs to send.
		edits[0]!.resolve({ open: true, accepted: true, revision: 1 });
		await Bun.sleep(0);
		expect(edits).toHaveLength(2);
		edits[1]!.resolve({ open: true, accepted: true, revision: 2 });
		await Bun.sleep(0);
		expect(edits).toHaveLength(3);
		let second = grow(definition, model, "o10", "Hosted provider");
		if (!second.ok) throw new Error("setup");
		definition = second.definition;
		model = second.model;
		emitChanged(2);
		await Bun.sleep(10);
		expect(opens).toBe(3);
		expect(edits).toHaveLength(4);
		edits[2]!.resolve({ open: true, accepted: true, revision: 3 });
		await Bun.sleep(0);
		let third = grow(definition, model, "o11", "Bring our own keys");
		if (!third.ok) throw new Error("setup");
		definition = third.definition;
		model = third.model;
		emitChanged(3);
		await Bun.sleep(10);
		expect(opens).toBe(4);
		expect(edits).toHaveLength(5);
		expect(controller.getSnapshot().drafts.q0?.choice).toBe("o1");
		off();
	});

	it("returns friendly closed and offline errors and forwards server limits", async () => {
		let asked: Array<{ kind: string; payload: Record<string, unknown> }> = [];
		let result: unknown = { ok: false, message: "That is already an option" };
		let wire = {
			async ask(kind: string, payload: Record<string, unknown>) {
				asked.push({ kind, payload });
				return result;
			},
			send() {},
			on() {
				return () => {};
			},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		expect(await controller.addOption("Canary")).toEqual({
			ok: false,
			message: "That is already an option",
		});
		result = { ok: false, message: "A decision holds at most 10 options" };
		expect(await controller.addOption("Another")).toEqual({
			ok: false,
			message: "A decision holds at most 10 options",
		});
		result = { ok: true };
		expect(await controller.addOption("New option")).toEqual({ ok: true });
		expect(asked.map(call => call.kind)).toEqual([
			"question:add-option",
			"question:add-option",
			"question:add-option",
		]);
		expect(asked[2]?.payload).toEqual({ id: "w", label: "New option" });

		controller.configure(DEFINITION, false);
		expect(await controller.addOption("Offline")).toMatchObject({ ok: false });
		expect(asked).toHaveLength(3);
		controller.forget();
		expect(await controller.addOption("Closed")).toMatchObject({ ok: false });
		expect(asked).toHaveLength(3);
	});
});
