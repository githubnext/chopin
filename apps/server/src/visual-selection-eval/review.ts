import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadCases } from "./source";

import type { RecordEvent } from "./experiment";

function option(name: string): string | undefined {
	let index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

let registry = option("--registry");
let manifest = option("--manifest") ?? "evals/visual-selection/cases.json";
let results = option("--results");
let output = option("--output");
if (!registry || !results || !output) {
	throw new Error("Provide --registry, --results, and --output paths");
}
let cases = await loadCases(manifest, registry);
let rows = (await readFile(results, "utf8")).trim().split("\n")
	.map(line => JSON.parse(line) as RecordEvent);
let strategies = rows.filter(row => row.kind === "strategy");
let ranked = cases.map(source => {
	let attempts = strategies.filter(row => row.caseId === source.id);
	let choices = attempts.flatMap(row => row.model ? [row.model.answer.choice] : []);
	return {
		source,
		attempts,
		disagreement: new Set(choices).size > 1,
		failure: attempts.some(row => row.status !== "complete"),
	};
}).filter(item => item.attempts.length > 0).sort((a, b) =>
	Number(b.disagreement) - Number(a.disagreement)
	|| Number(b.failure) - Number(a.failure)
);
if (ranked.length === 0) throw new Error("No strategy attempts to review");
let lines = [
	"# Visual selection: human review queue",
	"",
	"Automated checks cover shape and rendering only. Score usefulness and source grounding by hand.",
	"All source links are inert. This file is a local evaluation artifact, not model input.",
	"",
];
let assets = join(dirname(output), "review-assets");
await mkdir(assets, { recursive: true });
for (let item of ranked.slice(0, 4)) {
	lines.push(
		`## ${item.source.id}`,
		"",
		`Disagreement: ${item.disagreement ? "yes" : "no"} · Failure: ${item.failure ? "yes" : "no"}`,
		"",
		"### Frozen source",
		"",
		"```json",
		JSON.stringify(item.source.input, null, 2),
		"```",
		"",
	);
	for (let attempt of item.attempts) {
		if (attempt.kind !== "strategy") continue;
		lines.push(`### ${attempt.strategy}`, "", `Status: ${attempt.status}`, "");
		if (attempt.model) {
			lines.push(
				`Choice: ${attempt.model.answer.choice}`,
				"",
				"```json",
				JSON.stringify(attempt.model.answer, null, 2),
				"```",
				"",
			);
			if (attempt.render?.ok) {
				let name = `${item.source.cluster}-${item.source.checkpoint}-${attempt.strategy}.svg`;
				let box = attempt.render.viewBox.join(" ");
				await writeFile(
					join(assets, name),
					`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${attempt.render.body}</svg>`,
				);
				lines.push(`![Rendered ${attempt.strategy} diagram](review-assets/${name})`, "");
			}
		} else {
			lines.push(attempt.problem ?? "No model output", "");
		}
	}
	lines.push(
		"### Reviewer",
		"",
		"Acceptable choices (multiple allowed):",
		"",
		"Useful choice 0–2: · Faithfulness 0–2: · Data sufficiency 0–2:",
		"",
		"Readable result 0–2: · Appropriate abstention 0–2: · Notes:",
		"",
	);
}
await writeFile(output, lines.join("\n"));
console.log(`Wrote ${Math.min(4, ranked.length)} source/output review pairs to ${output}`);
