/**
 * Writes `e2e/shard-timings.json` from a merged browser integration report, so
 * `e2e/shard-balance.ts` can place files by how long they took. CI keeps the
 * report as the `browser-test-summary` artifact (`integration.json`).
 *
 *   bun scripts/e2e-shard-timings.ts path/to/integration.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";

let source = process.argv[2];
if (!source) throw new Error("usage: bun scripts/e2e-shard-timings.ts <integration.json>");
let report: JSONReport = JSON.parse(await readFile(source, "utf8"));

let files: Record<string, { ms: number; tests: number }> = {};
function visit(suite: JSONReportSuite) {
	for (let spec of suite.specs) {
		for (let test of spec.tests) {
			let entry = files[spec.file] ??= { ms: 0, tests: 0 };
			// The first attempt: a retry is the exception, not the expected cost.
			entry.ms += Math.round(test.results[0]?.duration ?? 0);
			entry.tests += 1;
		}
	}
	for (let child of suite.suites ?? []) visit(child);
}
for (let suite of report.suites) visit(suite);

let sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
let target = fileURLToPath(new URL("../e2e/shard-timings.json", import.meta.url));
await writeFile(target, JSON.stringify(sorted, null, "\t") + "\n");
console.log(`${Object.keys(sorted).length} files written to ${target}`);
