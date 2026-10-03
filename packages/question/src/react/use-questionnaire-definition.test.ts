import { describe, expect, it } from "bun:test";

import { create } from "../index";
import { QuestionnaireController } from "./use-questionnaire";

import type { Definition } from "../index";
import type { Transport } from "./use-questionnaire";

function legacy(): Definition {
	return {
		questions: ["saved-first", "saved-second"].map(id => ({
			id,
			header: id,
			question: `${id}?`,
			multiple: false,
			options: [{ id: `${id}-option`, label: "One", description: "" }],
		})),
	};
}

function bridge(definition: unknown, modelDefinition: Definition) {
	let opens = 0;
	let submissions = 0;
	let model = create(modelDefinition);
	let value = {
		async ask(kind: string) {
			if (kind === "question:open") {
				opens++;
				return { open: true, definition, model: [...model.toBinary()], revision: 4, presence: [] };
			}
			if (kind === "question:submit") submissions++;
			throw new Error(`Unexpected ${kind}`);
		},
		send() {},
		on() {
			return () => {};
		},
	} as unknown as Transport;
	return { value, opens: () => opens, submissions: () => submissions };
}

describe("QuestionnaireController shared definitions", () => {
	it("opens a legacy multi-question definition with its durable question and option IDs", async () => {
		let definition = legacy();
		let channel = bridge(definition, definition);
		let controller = new QuestionnaireController(channel.value, "saved-card", undefined, true);
		let off = controller.subscribe(() => {});
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			let snapshot = controller.getSnapshot();
			expect(snapshot.error).toBeUndefined();
			expect(snapshot.syncing).toBe(false);
			expect(snapshot.definition).toEqual(definition);
			expect(Object.keys(snapshot.drafts)).toEqual(["saved-first", "saved-second"]);
			expect(snapshot.drafts["saved-second"]?.options).toEqual({ "saved-second-option": false });
			expect(channel.opens()).toBe(1);
			expect(channel.submissions()).toBe(0);
		} finally {
			off();
		}
	});

	it("opens a pending empty single-choice card without changing its durable ID or mode", async () => {
		let definition: Definition = {
			questions: [{
				id: "pending-question",
				header: "Choice",
				question: "Which option?",
				multiple: false,
				options: [],
			}],
		};
		let channel = bridge(definition, definition);
		let controller = new QuestionnaireController(channel.value, "pending-card", undefined, true);
		let off = controller.subscribe(() => {});
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(controller.getSnapshot().error).toBeUndefined();
			expect(controller.getSnapshot().definition).toEqual(definition);
			expect(controller.getSnapshot().drafts).toEqual({
				"pending-question": { mode: "choices", choice: null, custom: "", options: {} },
			});
		} finally {
			off();
		}
	});

	it("rejects an invalid identified open payload before accepting the shared definition", async () => {
		let definition = { questions: [legacy().questions[0]!] };
		let channel = bridge({ ...definition, extra: true }, definition);
		let controller = new QuestionnaireController(channel.value, "invalid-card", undefined, true);
		let off = controller.subscribe(() => {});
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(controller.getSnapshot().error).toBe("Unable to sync shared answers.");
			expect(controller.getSnapshot().definition).toBeUndefined();
			expect(controller.getSnapshot().drafts).toEqual({});
			expect(channel.submissions()).toBe(0);
		} finally {
			off();
		}
	});
});
