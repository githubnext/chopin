import { expect, test } from "bun:test";
import { initialState } from "./index";
import { applySelection } from "./selection";
import { performance } from "./fixtures";

test("independent selections merge while stale same-field edits conflict", () => {
	let state = initialState(performance.views[0]);
	let filtered = applySelection(state, performance.datasets[0], {
		mutationId: crypto.randomUUID(),
		expected: { "filter:workload": 0 },
		set: { "filter:workload": ["small"] },
	});
	let selected = applySelection(filtered, performance.datasets[0], {
		mutationId: crypto.randomUUID(),
		expected: { selection: 0 },
		set: { selection: ["cached"] },
	});
	expect(selected.revision).toBe(2);
	expect(selected.fields["filter:workload"].values).toEqual(["small"]);
	expect(() =>
		applySelection(selected, performance.datasets[0], {
			mutationId: crypto.randomUUID(),
			expected: { selection: 0 },
			set: { selection: ["baseline"] },
		})
	).toThrow("collaborator");
	expect(state.revision).toBe(0);
});

test("rejects invented observations and unexpected fields before mutating state", () => {
	let state = initialState(performance.views[0]);
	let changes: Record<string, string[]>[] = [{ selection: ["missing"] }, { unknown: [] }, {
		"filter:workload": ["unmeasured"],
	}];
	for (let set of changes) {
		expect(() =>
			applySelection(state, performance.datasets[0], {
				mutationId: crypto.randomUUID(),
				expected: Object.fromEntries(Object.keys(set).map(key => [key, 0])),
				set,
			})
		).toThrow();
	}
	expect(state.revision).toBe(0);
});
