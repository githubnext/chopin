import { expect, test } from "bun:test";
import { create } from "../index";
import { QuestionnaireController } from "./use-questionnaire";
import { DEFINITION } from "./use-questionnaire.test-fixtures";
import type { Transport } from "./use-questionnaire";

function cancelBridge() {
	let model = create(DEFINITION);
	let requests: string[] = [];
	let handlers = new Map<string, Set<(event: never) => void>>();
	let settle!: (reply: unknown) => void;
	let cancellation = new Promise(resolve => settle = resolve);
	let value = {
		ask(kind: string) {
			requests.push(kind);
			if (kind === "question:open") {
				return Promise.resolve({
					open: true,
					definition: DEFINITION,
					model: [...model.toBinary()],
					revision: 0,
					presence: [],
				});
			}
			if (kind === "question:cancel") return cancellation;
			throw new Error(`Unexpected ${kind}`);
		},
		send() {},
		on(kind: string, handler: (event: never) => void) {
			let listeners = handlers.get(kind) ?? new Set();
			handlers.set(kind, listeners);
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	} as unknown as Transport;
	return { value, requests, handlers, settle };
}

test("the existing cancel API still sends question:cancel and closes its controller", async () => {
	let bridge = cancelBridge();
	let controller = new QuestionnaireController(bridge.value, "w", DEFINITION, true);
	let off = controller.subscribe(() => {});
	await Bun.sleep(0);
	controller.cancel();
	expect(controller.getSnapshot().submitting).toBe(true);
	bridge.settle({ ok: true });
	await Bun.sleep(0);
	expect(bridge.requests).toEqual(["question:open", "question:cancel"]);
	expect(controller.getSnapshot().closed).toBe(true);
	expect([...bridge.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
	off();
});

test("a refused cancel releases its listeners after the last view unmounts", async () => {
	let bridge = cancelBridge();
	let controller = new QuestionnaireController(bridge.value, "w", DEFINITION, true);
	let off = controller.subscribe(() => {});
	await Bun.sleep(0);
	controller.cancel();
	off();
	await Bun.sleep(0);
	bridge.settle({ ok: false });
	await Bun.sleep(0);
	expect(bridge.requests).toEqual(["question:open", "question:cancel"]);
	expect(controller.getSnapshot().error).toBe("Could not cancel this question.");
	expect(controller.getSnapshot().submitting).toBe(false);
	expect([...bridge.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
});
