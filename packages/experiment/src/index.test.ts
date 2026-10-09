import { expect, test } from "bun:test";
import { capabilities, initialState, limits, parseResult, selectedRows } from "./index";
import { ci, performance } from "./fixtures";

test("typed captured datasets support deterministic filtering and numeric zero", () => {
	let result = structuredClone(performance);
	result.datasets[0].rows[0].values.milliseconds = 0;
	expect(parseResult(result).datasets[0].rows[0].values.milliseconds).toBe(0);
	let state = initialState(result.views[0]);
	state.fields["filter:workload"].values = ["large"];
	expect(selectedRows(result.datasets[0], state).map(row => row.key)).toEqual(["large"]);
	expect(parseResult(ci)).toEqual(ci);
});

test("rejects type mismatches, unknown columns, duplicate identities and invalid mappings", () => {
	for (
		let mutate of [
			(value: typeof performance) => {
				value.datasets[0].rows[0].values.milliseconds = "0";
			},
			(value: typeof performance) => {
				value.datasets[0].rows[0].values.extra = 2;
			},
			(value: typeof performance) => {
				value.datasets[0].rows[1].key = "baseline";
			},
			(value: typeof performance) => {
				value.views[0].valueColumn = "approach";
			},
			(value: typeof performance) => {
				value.views[0].filterColumns = ["unknown"];
			},
			(value: typeof performance) => {
				value.views[0].datasetKey = "missing";
			},
			(value: typeof performance) => {
				value.datasets[0].rows[0].values.milliseconds = Infinity;
			},
		]
	) {
		let value = structuredClone(performance);
		mutate(value);
		expect(() => parseResult(value)).toThrow();
	}
});

test("rejects executable configuration and oversized reports; supports report-only results", () => {
	expect(() => parseResult({ ...performance, script: "alert(1)" })).toThrow();
	expect(() => parseResult({ ...performance, report: "x".repeat(limits.report + 1) })).toThrow();
	expect(parseResult({ ...performance, datasets: [], views: [] }).report).toBe(performance.report);
	expect(capabilities.resultSchema).toHaveProperty("additionalProperties", false);
});

test("missing and nullable values remain distinct", () => {
	let value = structuredClone(performance);
	value.datasets[0].rows[0].values.milliseconds = null;
	expect(() => parseResult(value)).toThrow();
	value.datasets[0].columns[2].nullable = true;
	expect(parseResult(value).datasets[0].rows[0].values.milliseconds).toBeNull();
	delete value.datasets[0].rows[0].values.milliseconds;
	expect(() => parseResult(value)).toThrow();
});
