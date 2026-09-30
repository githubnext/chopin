import { expect, test } from "bun:test";
import { createProcessor } from "./service";
import { entry, harness } from "./service.test-fixtures";

test("processor captures plan and initial effects once before reporting dependency", async () => {
	let setup = harness();
	let order: string[] = [];
	let planReads = 0;
	let effectReads = 0;
	let alternate = structuredClone(setup.plan);
	Object.defineProperty(setup.dependencies, "plan", {
		get() {
			order.push("plan");
			return ++planReads === 1 ? setup.plan : alternate;
		},
	});
	Object.defineProperty(setup.dependencies, "effects", {
		get() {
			order.push("effects");
			effectReads++;
			if (effectReads > 1) throw new Error("effects reread");
			return undefined;
		},
	});
	let onError = setup.dependencies.onError;
	Object.defineProperty(setup.dependencies, "onError", {
		get() {
			order.push("onError");
			return onError;
		},
	});
	let processor = createProcessor(setup.dependencies);
	try {
		expect(order).toEqual(["plan", "effects", "onError"]);
		expect(Object.keys(processor)).toEqual([
			"accept",
			"afterMessage",
			"correct",
			"saveScopedChoice",
			"researchConsent",
			"record",
			"retry",
			"setEffects",
			"wake",
			"stop",
		]);
		await processor.accept(entry("captured-plan", "Which auth system?"));
		expect(planReads).toBe(1);
		expect(effectReads).toBe(1);
		expect(setup.plan.chat.entries.map(message => message.id)).toEqual(["captured-plan"]);
		expect(alternate.chat.entries).toEqual([]);
	} finally {
		processor.stop();
	}
});
