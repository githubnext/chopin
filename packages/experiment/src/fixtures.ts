import { parseResult } from "./index";

export const performance = parseResult({
	schemaVersion: 1,
	report: "# Startup comparison\n\nCaching reduced median startup time in the captured workload.\n",
	datasets: [{
		key: "startup",
		title: "Median startup time",
		columns: [
			{ key: "approach", label: "Approach", type: "string" },
			{ key: "workload", label: "Workload", type: "string" },
			{ key: "milliseconds", label: "Median", type: "number", unit: "ms" },
		],
		rows: [
			{ key: "baseline", values: { approach: "Baseline", workload: "small", milliseconds: 240 } },
			{ key: "cached", values: { approach: "Cached", workload: "small", milliseconds: 183 } },
			{ key: "large", values: { approach: "Cached", workload: "large", milliseconds: 410 } },
		],
		method: "Illustrative fixture: 10 sequential runs, median after one warm-up.",
		basis: "simulated",
		sources: [{ label: "Fixture", capturedAt: "2026-10-08T12:00:00Z" }],
	}],
	views: [{
		key: "comparison",
		title: "Startup",
		kind: "bar-chart",
		datasetKey: "startup",
		categoryColumn: "approach",
		valueColumn: "milliseconds",
		filterColumns: ["workload"],
	}],
	evidence: [],
	provenance: {
		environment: "Deterministic example, not measured evidence",
		checks: [],
		limitations: ["Simulated values"],
	},
});

export const ci = parseResult({
	...performance,
	report:
		"# CI queue time\n\nBrowser tests wait longer than unit tests in this illustrative sample.\n",
	datasets: [{
		key: "queue",
		title: "CI queue time",
		columns: [
			{ key: "job", label: "Job", type: "string" },
			{ key: "seconds", label: "Waiting", type: "number", unit: "s" },
		],
		rows: [
			{ key: "unit", values: { job: "Unit tests", seconds: 18 } },
			{ key: "browser", values: { job: "Browser tests", seconds: 142 } },
		],
		method: "Illustrative captured-job comparison",
		basis: "simulated",
		sources: [],
	}],
	views: [{
		key: "queue",
		title: "Waiting time",
		kind: "metric-comparison",
		datasetKey: "queue",
		categoryColumn: "job",
		valueColumn: "seconds",
		filterColumns: [],
	}],
});
