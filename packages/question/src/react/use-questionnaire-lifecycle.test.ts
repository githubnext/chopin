import { describe, expect, it } from "bun:test";
import { create } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";
import { DEFINITION, transport } from "./use-questionnaire.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks, wrappers only.
describe("QuestionnaireController lifecycle", () => {
	it("discards an open decision", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);

		controller.discard();
		await Bun.sleep(0);

		expect(bridge.discards()).toEqual(["question-1"]);
		expect(controller.getSnapshot().closed).toBe(true);
		off();
	});

	it("reopen reports a server refusal without changing the closed controller", async () => {
		let asked: string[] = [];
		let wire = {
			ask: async (kind: string) => {
				asked.push(kind);
				return { ok: false, reason: "not-decided" };
			},
			send() {},
			on: () => () => {},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		controller.forget();
		expect(await controller.reopen()).toEqual({
			ok: false,
			message: "Only a decided card can be reopened.",
		});
		expect(asked).toEqual(["question:reopen"]);
		expect(controller.getSnapshot().closed).toBe(true);
	});

	it("reopen reports connection and transport failures", async () => {
		let offline = new QuestionnaireController(undefined, "w", DEFINITION, false);
		expect(await offline.reopen()).toEqual({ ok: false, message: "Not connected." });

		let wire = {
			ask: async () => {
				throw new Error("connection lost");
			},
			send() {},
			on: () => () => {},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		expect(await controller.reopen()).toEqual({
			ok: false,
			message: "Could not reopen it. Try again.",
		});
	});

	it("does not revive a retired draft from a late open reply", async () => {
		let reply!: (value: unknown) => void;
		let wire = {
			ask: () => new Promise(resolve => reply = resolve),
			send() {},
			on: () => () => {},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		controller.forget();
		reply({
			open: true,
			definition: DEFINITION,
			model: [...create(DEFINITION).toBinary()],
			revision: 0,
			presence: [],
		});
		await Bun.sleep(0);
		expect(controller.getSnapshot().closed).toBe(true);
		expect(controller.getSnapshot().drafts).toEqual({});
		off();
	});
});
