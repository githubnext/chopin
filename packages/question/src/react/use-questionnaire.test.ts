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

const QUESTIONNAIRE = normalize({
	questions: [
		{
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ label: "Canary", description: "Small percentage first." }],
		},
		{
			header: "Timing",
			question: "When should we deploy?",
			multiple: false,
			options: [{ label: "Tomorrow", description: "" }],
		},
	],
});

function transport(definition = DEFINITION) {
	let opens = 0;
	let edits = 0;
	let submits = 0;
	let submitIds: string[] = [];
	let submitRevisions: number[] = [];
	let presence = 0;
	let handlers = new Map<string, Set<(event: never) => void>>();
	let model = create(definition);

	let value = {
		async ask(kind: string, payload: Record<string, unknown>) {
			if (kind === "question:open") {
				opens++;
				return {
					open: true,
					definition,
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
				submitIds.push(payload.id as string);
				submitRevisions.push(payload.revision as number);
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
		submitIds: () => submitIds,
		submitRevisions: () => submitRevisions,
		presence: () => presence,
	};
}

describe("QuestionnaireController", () => {
	it("rejects a questionnaire returned for an independent decision record", async () => {
		let bridge = transport(QUESTIONNAIRE);
		let controller = new QuestionnaireController(
			bridge.value,
			"question-1",
			QUESTIONNAIRE,
			true,
		);
		let off = controller.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(controller.getSnapshot().error).toBe("Unable to sync shared answers.");
		expect(bridge.submits()).toBe(0);
		off();
	});

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
		await new Promise(resolve => setTimeout(resolve, 10));

		expect(bridge.submits()).toBe(1);
		expect(controller.getSnapshot().submitting).toBe(true);
		off();
	});

	it("submits after every local edit has advanced the shared revision", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		controller.change("q0", { choice: "o0" });
		await new Promise(resolve => queueMicrotask(resolve));
		controller.change("q0", { custom: "because" });
		controller.submit();
		await new Promise(resolve => setTimeout(resolve, 10));

		expect(bridge.edits()).toBe(2);
		expect(bridge.submitRevisions()).toEqual([2]);
		off();
	});

	it("keeps validation inside the card being saved", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		controller.submit();

		expect(bridge.submits()).toBe(0);
		expect(controller.getSnapshot().focus).toBe("q0");
		expect(controller.getSnapshot().error).toBe("Rollout requires an answer");
		off();
	});

	it("persists one card without changing its unanswered sibling", async () => {
		let bridge = transport();
		let first = new QuestionnaireController(bridge.value, "first", DEFINITION, true);
		let sibling = new QuestionnaireController(bridge.value, "sibling", DEFINITION, true);
		let offFirst = first.subscribe(() => {});
		let offSibling = sibling.subscribe(() => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		first.change("q0", { choice: "o0" });
		first.submit();
		await new Promise(resolve => setTimeout(resolve, 10));

		expect(bridge.submitIds()).toEqual(["first"]);
		expect(sibling.getSnapshot().drafts.q0?.choice).toBeNull();
		expect(sibling.getSnapshot().error).toBeUndefined();
		expect(sibling.getSnapshot().submitting).toBe(false);
		offFirst();
		offSibling();
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
