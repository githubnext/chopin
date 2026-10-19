import { describe, expect, it } from "bun:test";
import { appendCriterion, create, decision, normalize } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import type { Transport } from "./use-questionnaire";

let DEFINITION = decision(normalize({
	questions: [{
		header: "Storage",
		question: "Where does progress live?",
		multiple: false,
		options: [{ label: "Account", description: "" }, { label: "Browser", description: "" }],
		criteria: [{ label: "New device" }],
	}],
}));

function harness() {
	let handlers = new Map<string, Set<(event: never) => void>>();
	let asked: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	let model = create(DEFINITION);
	let wire = {
		async ask(kind: string, payload: Record<string, unknown>) {
			asked.push({ kind, payload });
			if (kind === "question:open") {
				return {
					open: true,
					definition: DEFINITION,
					model: [...model.toBinary()],
					revision: 0,
					presence: [],
				};
			}
			if (kind === "question:edit") return { open: true, accepted: true, revision: 1 };
			if (kind === "question:criterion") {
				let next = appendCriterion(DEFINITION, {
					question: "q0",
					key: payload.key as string,
					label: payload.label,
				}, "c1");
				if (!next.ok) return { ok: false, reason: next.reason, message: next.message };
				return { ok: true, criterion: next.criterion, definition: next.definition };
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
	return { wire, asked, handlers };
}

describe("QuestionnaireController criteria", () => {
	it("marks a cell in the shared draft and sends the patch", async () => {
		let { wire, asked } = harness();
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		let [option] = DEFINITION.questions[0]!.options;
		controller.mark("q0", option!.id, "c0", "partly");
		await Bun.sleep(0);
		expect(controller.getSnapshot().drafts.q0?.marks).toEqual({ [`${option!.id}/c0`]: "partly" });
		expect(asked.filter(call => call.kind === "question:edit")).toHaveLength(1);
		controller.mark("q0", option!.id, "c0", null);
		await Bun.sleep(0);
		expect(controller.getSnapshot().drafts.q0?.marks).toEqual({ [`${option!.id}/c0`]: null });
		off();
	});

	it("appends a criterion with a stable key per attempt and adopts the definition", async () => {
		let { wire, asked } = harness();
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		expect(await controller.addCriterion("q0", "Easy reset")).toEqual({
			ok: true,
			criterion: "c1",
		});
		let call = asked.find(each => each.kind === "question:criterion");
		expect(call?.payload).toMatchObject({ id: "w", question: "q0", label: "Easy reset" });
		expect(call?.payload.key).toEqual(expect.any(String));
		expect(controller.getSnapshot().definition?.questions[0]?.criteria).toHaveLength(2);
		off();
	});

	it("takes a definition that gained only a criterion, and never goes back", async () => {
		let { wire, handlers } = harness();
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		let off = controller.subscribe(() => {});
		await Bun.sleep(0);
		let grown = appendCriterion(DEFINITION, {
			question: "q0",
			key: crypto.randomUUID(),
			label: "Easy reset",
		}, "c1");
		if (!grown.ok) throw new Error("setup");
		for (let handler of handlers.get("question:criterion-added") ?? []) {
			handler({ id: "w", definition: grown.definition } as never);
		}
		expect(controller.getSnapshot().definition?.questions[0]?.criteria).toHaveLength(2);
		// A late event carrying the older definition must not remove the column.
		for (let handler of handlers.get("question:criterion-added") ?? []) {
			handler({ id: "w", definition: DEFINITION } as never);
		}
		expect(controller.getSnapshot().definition?.questions[0]?.criteria).toHaveLength(2);
		off();
	});

	it("keeps a refusal's message and sends nothing once closed", async () => {
		let { wire, asked } = harness();
		let controller = new QuestionnaireController(wire, "w", DEFINITION, true);
		expect(await controller.addCriterion("q0", "New device")).toEqual({
			ok: false,
			message: "That criterion already exists",
		});
		controller.forget();
		expect(await controller.addCriterion("q0", "Late")).toMatchObject({ ok: false });
		expect(asked.filter(call => call.kind === "question:criterion")).toHaveLength(1);
	});
});
