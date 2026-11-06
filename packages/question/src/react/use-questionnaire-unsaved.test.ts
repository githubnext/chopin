import { hasPendingWork } from "@chopin/protocol/pending-work";
import { describe, expect, it } from "bun:test";
import { create } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";
import { DEFINITION } from "./use-questionnaire.test-fixtures";

describe("QuestionnaireController unsaved work", () => {
	it("holds the page from reloading while an answer edit has not reached the server", async () => {
		let model = create(DEFINITION);
		let settleEdit!: (reply: unknown) => void;
		let wire = {
			ask(kind: string) {
				if (kind === "question:open") {
					return Promise.resolve({
						open: true,
						definition: DEFINITION,
						model: [...model.toBinary()],
						revision: 0,
						presence: [],
					});
				}
				if (kind === "question:edit") return new Promise(resolve => settleEdit = resolve);
				throw new Error(`Unexpected ${kind}`);
			},
			send() {},
			on: () => () => {},
		} as unknown as Transport;
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		expect(controller.unsaved).toBe(false);

		controller.change("q0", { choice: "o0" });
		await Bun.sleep(0);
		expect(controller.unsaved).toBe(true);
		expect(hasPendingWork()).toBe(true);

		settleEdit({ open: true, accepted: true, revision: 1 });
		await Bun.sleep(0);
		expect(controller.unsaved).toBe(false);
		off();
	});
});
