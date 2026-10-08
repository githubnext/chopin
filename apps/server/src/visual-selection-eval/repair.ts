import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { shutdownHarnesses } from "../harness/harnesses";
import { GENERATOR_INSTRUCTIONS } from "./catalogue";
import { modelGenerator } from "./model";
import { loadCases } from "./source";

import type { RecordEvent } from "./experiment";

function option(name: string): string | undefined {
	let index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

let registry = option("--registry");
let manifest = option("--manifest") ?? "evals/visual-selection/cases.json";
let baseline = option("--baseline");
let output = option("--output");
if (!registry || !baseline || !output) {
	throw new Error("Provide --registry, --baseline, and a new --output path");
}
let cases = await loadCases(manifest, registry);
let rows = (await readFile(baseline, "utf8")).trim().split("\n").map(line =>
	JSON.parse(line) as RecordEvent
);
let failures = rows.filter(row => row.kind === "strategy" && row.status === "model-error");
if (failures.length > 60) throw new Error("Repair exceeds the baseline attempt bound");
let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) {
	let { stdout } = await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" });
	token = stdout.trim();
}
if (!token) throw new Error("Copilot user token unavailable");
await mkdir(dirname(output), { recursive: true });
await writeFile(
	output,
	JSON.stringify({
		kind: "repair-run",
		baseline,
		attempts: failures.length,
		createdAt: new Date().toISOString(),
		label: "separate mechanical retry; do not combine with first baseline",
	}) + "\n",
	{ flag: "wx" },
);
let generate = modelGenerator({
	harness: "copilot-sdk",
	model: "gpt-6-luna",
	token,
	timeoutMs: 90_000,
});
try {
	for (let failure of failures) {
		if (failure.kind !== "strategy") continue;
		let source = cases.find(item => item.id === failure.caseId);
		if (!source) throw new Error(`Missing frozen source: ${failure.caseId}`);
		let started = performance.now();
		let result: object;
		try {
			let model = await generate(source.input, failure.allowed, GENERATOR_INSTRUCTIONS);
			result = {
				kind: "repair",
				caseId: failure.caseId,
				strategy: failure.strategy,
				status: "generated",
				model,
			};
		} catch (error) {
			let detail = error as { text?: unknown; cause?: { message?: unknown }; usage?: unknown };
			result = {
				kind: "repair",
				caseId: failure.caseId,
				strategy: failure.strategy,
				status: "model-error",
				latencyMs: Math.round(performance.now() - started),
				error: String(error),
				rawText: typeof detail.text === "string" ? detail.text : null,
				cause: typeof detail.cause?.message === "string" ? detail.cause.message : null,
				usage: detail.usage ?? null,
			};
		}
		await appendFile(output, JSON.stringify(result) + "\n");
		console.log(`Repair recorded: ${failure.caseId} / ${failure.strategy}`);
	}
} finally {
	await shutdownHarnesses();
}
