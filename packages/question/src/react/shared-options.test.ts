import { describe, expect, it } from "bun:test";

import { appendOption, create, decision, normalize } from "../index";
import { QuestionnaireController } from "./use-questionnaire";

import type { Transport } from "./use-questionnaire";

const single = decision(normalize({
	questions: [{
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [
			{ label: "Canary", description: "Small percentage first." },
			{ label: "Blue-green", description: "" },
		],
	}],
}));

function sharing(replies: Array<"lost" | "refuse" | "accept"> = ["accept"]) {
	let asks: Array<Record<string, unknown>> = [];
	let handlers = new Map<string, Set<(event: never) => void>>();
	let model = create(single);
	let grown = single;
	let next = [...replies];
	let value = {
		async ask(kind: string, payload: Record<string, unknown>) {
			if (kind === "question:open") {
				return {
					open: true,
					definition: grown,
					model: [...model.toBinary()],
					revision: 0,
					presence: [],
				};
			}
			if (kind === "question:edit") {
				return { open: true, accepted: true, applied: false, revision: 1 };
			}
			if (kind === "question:option") {
				asks.push(payload);
				let mode = next.shift() ?? "accept";
				if (mode === "lost") throw new Error("timeout");
				if (mode === "refuse") {
					return { ok: false, reason: "duplicate", message: "That option already exists" };
				}
				let result = appendOption(grown, {
					question: "q0",
					key: payload.key as string,
					label: payload.label,
				}, `n${asks.length}`);
				if (!result.ok) throw new Error("unexpected");
				grown = result.definition;
				return { ok: true, option: result.option, definition: grown };
			}
			throw new Error(`Unexpected ${kind}`);
		},
		send() {},
		on(kind: string, handler: (event: never) => void) {
			let set = handlers.get(kind);
			if (!set) handlers.set(kind, set = new Set());
			set.add(handler);
			return () => set.delete(handler);
		},
	} as unknown as Transport;
	let emit = (kind: string, event: unknown) => {
		for (let handler of handlers.get(kind) ?? []) handler(event as never);
	};
	return { value, asks, emit };
}

async function started(bridge: Transport) {
	let controller = new QuestionnaireController(bridge, "question-1", single, true);
	let off = controller.subscribe(() => {});
	await new Promise(resolve => setTimeout(resolve, 0));
	return { controller, off };
}

describe("shared options", () => {
	it("takes the definition from the acknowledgement", async () => {
		let bridge = sharing();
		let { controller, off } = await started(bridge.value);

		let result = await controller.addOption("q0", "Shadow");

		let added = controller.getSnapshot().definition!.questions[0]!.options[2]!;
		expect(result).toEqual({ ok: true, optionId: added.id });
		expect(controller.getSnapshot().definition!.questions[0]!.options.map(option => option.label))
			.toEqual(["Canary", "Blue-green", "Shadow"]);
		off();
	});

	it("surfaces a refusal without changing the definition", async () => {
		let bridge = sharing(["refuse"]);
		let { controller, off } = await started(bridge.value);

		expect(await controller.addOption("q0", "canary")).toEqual({
			ok: false,
			message: "That option already exists",
		});
		expect(controller.getSnapshot().definition!.questions[0]!.options).toHaveLength(2);
		off();
	});

	it("repeats the same key when the same text is retried after a lost reply", async () => {
		let bridge = sharing(["lost", "accept"]);
		let { controller, off } = await started(bridge.value);

		expect((await controller.addOption("q0", "Shadow")).ok).toBe(false);
		expect((await controller.addOption("q0", "Shadow")).ok).toBe(true);
		expect(bridge.asks[0]!.key).toBe(bridge.asks[1]!.key);

		await controller.addOption("q0", "Another");
		expect(bridge.asks[2]!.key).not.toBe(bridge.asks[0]!.key);
		off();
	});

	it("shows an option another member added and never goes back", async () => {
		let bridge = sharing();
		let { controller, off } = await started(bridge.value);
		let added = appendOption(single, { question: "q0", key: "0123456789", label: "Theirs" }, "x1");
		if (!added.ok) throw new Error("append failed");

		bridge.emit("question:option-added", { id: "question-1", definition: added.definition });
		let options = () => controller.getSnapshot().definition!.questions[0]!.options;
		expect(options().map(option => option.label)).toEqual(["Canary", "Blue-green", "Theirs"]);

		// A late, older copy of the definition is ignored.
		bridge.emit("question:option-added", { id: "question-1", definition: single });
		expect(options()).toHaveLength(3);
		// Another questionnaire's event is not ours.
		bridge.emit("question:option-added", { id: "other", definition: single });
		expect(options()).toHaveLength(3);
		off();
	});

	it("lets a draft select an option that has no register yet", async () => {
		let bridge = sharing();
		let { controller, off } = await started(bridge.value);
		await controller.addOption("q0", "Shadow");

		controller.change("q0", { options: { n1: true } });
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(controller.getSnapshot().drafts.q0?.options.n1).toBe(true);
		off();
	});
});
