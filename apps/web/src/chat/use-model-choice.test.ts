import { expect, test } from "bun:test";

import { pendingModel } from "./use-model-choice";

test("the composer waits for the models only while the Planner is coming and the offer is unknown", () => {
	let waiting = { choice: { model: "acme/large", thinkingLevel: "high" }, modelName: "Large" };
	expect(pendingModel(waiting, "starting")).toEqual({
		pending: true,
		name: "Large",
		level: "high",
	});
	expect(pendingModel({}, "attached")).toEqual({ pending: true, name: "Model" });
	// No machine is starting it (none chosen, one that can't start it, or one that went away).
	expect(pendingModel(waiting, undefined)).toBeUndefined();
	// The offer is known, though it may be nothing: a client that reported no models.
	expect(pendingModel(undefined, "attached")).toBeUndefined();
});
