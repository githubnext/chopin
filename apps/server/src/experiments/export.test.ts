import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { datasetCsv } from "./export";

test("CSV exports quote delimiters and neutralize text formulas while retaining numeric values", () => {
	let dataset = structuredClone(performance.datasets[0]);
	dataset.rows[0].values.approach = '=HYPERLINK("bad")';
	dataset.rows[0].values.milliseconds = -12;
	expect(datasetCsv(dataset)).toContain('"\'=HYPERLINK(""bad"")","small","-12"');
});
