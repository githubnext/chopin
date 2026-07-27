import { describe, expect, it } from "bun:test";

import { create, normalize } from "../index";
import { QuestionnaireController } from "./use-questionnaire";

import type { Transport } from "./use-questionnaire";

const DEFINITION = normalize({
	questions: [{
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [
			{ label: "Canary", description: "Small percentage first." },
			{ label: "Blue-green", description: "" },
		],
	}],
});

function transport() {
	let opens = 0;
	let edits = 0;
	let submits = 0;
	let presence = 0;
	let handlers = new Map<string, Set<(event: never) => void>>();
	let model = create(DEFINITION);

	let value = {
		async ask(kind: string) {
			if (kind === "question:open") {
				opens++;
				return {
					open: true,
					definition: DEFINITION,
					model: [...model.toBinary()],
					revision: 0,
					presence: [],
				};
			}
			if (kind === "question:edit") {
				edits++;
				return { open: true, accepted: true, applied: false, revision: edits };
			}
			if (kind === "question:submit") {
				submits++;
				return { ok: true };
			}
			throw new Error(`Unexpected ${kind}`);
		},
		send(kind: string) {
			if (kind === "question:presence") presence++;
		},
		on(kind: string, handler: (event: never) => void) {
			let set = handlers.get(kind);
			if (!set) handlers.set(kind, set = new Set());
			set.add(handler);
			return () => set.delete(handler);
		},
	} as unknown as Transport;

	return {
		value,
		opens: () => opens,
		edits: () => edits,
		submits: () => submits,
		presence: () => presence,
	};
}

describe("QuestionnaireController", () => {
	it("gives two surfaces one model, one open and one presence lifecycle", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let first = controller.subscribe(() => {});
		let second = controller.subscribe(() => {});

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(bridge.opens()).toBe(1);

		controller.change("q0", { choice: "o0" });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(controller.getSnapshot().drafts.q0?.choice).toBe("o0");
		expect(bridge.edits()).toBe(1);

		// One surface going away must not clear connection-level presence while
		// another still shows the same questionnaire.
		first();
		expect(bridge.presence()).toBe(0);
		second();
		await new Promise(resolve => queueMicrotask(resolve));
		expect(bridge.presence()).toBe(1);
	});

	it("locks every surface as soon as a terminal operation starts", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		controller.change("q0", { choice: "o0" });
		controller.submit();
		controller.submit();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(bridge.submits()).toBe(1);
		expect(controller.getSnapshot().submitting).toBe(true);
		off();
	});

	it("does not restart transport during a Strict Mode subscribe cycle", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let first = controller.subscribe(() => {});
		first();
		let second = controller.subscribe(() => {});

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(bridge.opens()).toBe(1);
		expect(bridge.presence()).toBe(0);
		second();
	});
});
