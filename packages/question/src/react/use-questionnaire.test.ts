import { describe, expect, it } from "bun:test";

import { apply, create, decision, normalize, read } from "../index";
import { DEFINITION } from "./use-questionnaire.test-fixtures";
import { FocusReporter, QuestionnaireController } from "./use-questionnaire";

import type { Definition } from "../index";
import type { Transport } from "./use-questionnaire";

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
	let frames: Array<Record<string, unknown>> = [];
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
				// The server's own gate: an edit counts only if its wire bytes apply.
				let outcome = apply(model, definition, payload.patch as number[]);
				if (!outcome.ok) {
					return { open: true, accepted: false, revision: edits, message: outcome.message };
				}
				model = outcome.model;
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
		send(kind: string, payload: Record<string, unknown>) {
			if (kind === "question:presence") {
				presence++;
				frames.push(payload);
			}
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
		frames: () => frames,
		drafts: () => read(model, definition),
	};
}

async function open(definition: Definition) {
	let bridge = transport(definition);
	let controller = new QuestionnaireController(bridge.value, "question-1", definition, true);
	let off = controller.subscribe(() => {});
	await new Promise(resolve => setTimeout(resolve, 0));
	return { bridge, controller, off };
}

function settle() {
	return new Promise(resolve => setTimeout(resolve, 0));
}

describe("QuestionnaireController", () => {
	it("rejects a questionnaire returned for an independent decision record", () => {
		let bridge = transport(QUESTIONNAIRE);
		// Creation owns this constraint; existing persisted questionnaires remain readable.
		expect(() => decision(QUESTIONNAIRE)).toThrow(
			"A decision record must contain exactly one question",
		);
		expect(bridge.submits()).toBe(0);
	});

	it("rejects duplicate durable option IDs across questionnaire questions", async () => {
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

describe("question presence", () => {
	it("announces the focused question once opened, then clears on submit", async () => {
		let bridge = transport();
		let controller = new QuestionnaireController(bridge.value, "question-1", DEFINITION, true);
		let off = controller.subscribe(() => {});
		controller.focusQuestion("q1");
		expect(bridge.frames()).toEqual([]);
		await new Promise(resolve => setTimeout(resolve, 0));
		controller.focusQuestion("q1");
		expect(bridge.frames()).toEqual([{ id: "question-1", question: "q1" }]);
		controller.focusQuestion(undefined);
		expect(bridge.frames()).toEqual([{ id: "question-1", question: "q1" }, { id: "question-1" }]);
		off();
	});
});

describe("FocusReporter", () => {
	it("sends once per change, waits until online, and resends after a reconnect", () => {
		let sent: Array<string | undefined> = [];
		let reporter = new FocusReporter(question => sent.push(question));

		reporter.set("a");
		expect(sent).toEqual([]);
		reporter.online(true);
		reporter.set("a");
		reporter.set("a");
		reporter.set("b");
		reporter.set(undefined);
		reporter.set(undefined);
		expect(sent).toEqual(["a", "b", undefined]);

		reporter.set("b");
		reporter.online(false);
		reporter.set("c");
		reporter.online(true);
		expect(sent.slice(3)).toEqual(["b", "c"]);
	});
});

describe("custom answer edits", () => {
	let text = "  pasted in one input,\nwith spacing kept  ";

	for (let verbatim of [false, true]) {
		it(`stores one input into an empty custom answer (verbatim: ${verbatim})`, async () => {
			let definition = normalize({
				questions: [{
					header: "Scope",
					question: "Which areas?",
					multiple: true,
					options: [{ label: "Server", description: "" }, { label: "Web", description: "" }],
				}],
			}, { verbatim });
			let { bridge, controller, off } = await open(definition);

			controller.change("q0", { mode: "custom" });
			await settle();
			controller.change("q0", { custom: text });
			await settle();

			expect(controller.getSnapshot().error).toBeUndefined();
			expect(bridge.drafts().q0).toMatchObject({ mode: "custom", custom: text });
			off();
		});
	}

	it("stores a paste into a host dialog that has only a custom answer", async () => {
		let definition = normalize({
			questions: [{ header: "Editor", question: "Edit the notes", multiple: false, options: [] }],
		}, { verbatim: true });
		let { bridge, controller, off } = await open(definition);
		let long = "notes line\n".repeat(500);

		controller.change("q0", { custom: long });
		await settle();

		expect(bridge.drafts().q0?.custom).toBe(long);
		off();
	});

	it("replaces a non-empty custom answer", async () => {
		let { bridge, controller, off } = await open(DEFINITION);

		controller.change("q0", { mode: "custom" });
		await settle();
		controller.change("q0", { custom: "first" });
		await settle();
		expect(bridge.drafts().q0?.custom).toBe("first");
		controller.change("q0", { custom: text });
		await settle();

		expect(bridge.drafts().q0?.custom).toBe(text);
		off();
	});

	it("submits a verbatim answer that was typed and then cleared", async () => {
		let definition = normalize({
			questions: [{ header: "Input", question: "Name?", multiple: false, options: [] }],
		}, { verbatim: true });
		let { bridge, controller, off } = await open(definition);

		controller.change("q0", { custom: "typed" });
		await settle();
		controller.change("q0", { custom: "" });
		await settle();
		expect(bridge.drafts().q0?.custom).toBe("");

		controller.submit();
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(bridge.submits()).toBe(1);
		off();
	});
});
