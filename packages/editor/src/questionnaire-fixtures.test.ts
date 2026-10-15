import { describe, expect, it } from "bun:test";

import { DECIDED, questionnaireFixtureStore } from "./questionnaire-fixtures";

describe("questionnaireFixtureStore", () => {
	it("confirms an empty document as ready", () => {
		let store = questionnaireFixtureStore([]);
		expect(store.readinessSnapshot()).toBe("ready");
		expect(store.snapshot()).toEqual([]);
	});

	it("publishes questionnaires in order and their saved prose relation", () => {
		let store = questionnaireFixtureStore([DECIDED], {
			prose: [{ widget: DECIDED.id, anchors: [], orphaned: true }],
		});
		expect(store.snapshot().map(entry => entry.id)).toEqual([DECIDED.id]);
		expect(store.relations(DECIDED.id)).toEqual({ q: "orphaned" });
	});
});
