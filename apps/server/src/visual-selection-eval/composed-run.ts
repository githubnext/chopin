import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { askJev } from "../conversation-plan/jev";
import { shutdownHarnesses } from "../harness/harnesses";
import { COMPOSED_GENERATOR_INSTRUCTIONS, COMPOSED_TYPES } from "./composed-catalogue";
import { runComposed } from "./composed";
import { loadComposedCases } from "./composed-source";
import { modelGenerator } from "./model";

function option(name: string): string | undefined {
	let index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

async function jevKey(path?: string): Promise<string | undefined> {
	if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
		return process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
	}
	if (!path) return undefined;
	let file = await readFile(path, "utf8");
	let line = file.split(/\r?\n/).find(line => line.startsWith("JEV_API_KEY="));
	let value = line?.slice("JEV_API_KEY=".length).trim();
	if (value?.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
	return value || undefined;
}

let manifestPath = option("--manifest") ?? "data/visual-selection/composed/frozen-inputs.json";
let sourceRoot = option("--source-root") ?? "data/visual-selection/frozen-development";
let outputPath = option("--output");
let cases = await loadComposedCases(manifestPath, sourceRoot);
if (process.argv.includes("--dry-run")) {
	for (let item of cases) console.log(`${item.id}: ${item.passageSha256}`);
	process.exit(0);
}
if (!outputPath) throw new Error("Provide a new --output JSONL path");
let key = await jevKey(option("--jev-env"));
if (!key) throw new Error("Jev access unavailable");
let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) {
	let { stdout } = await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" });
	token = stdout.trim();
}
if (!token) throw new Error("Copilot user token unavailable");
let requestedModel = option("--model") ?? "gpt-6-luna";
let requestedJevModel = process.env.JEV_MODEL ?? "jev-latest";
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
	outputPath,
	JSON.stringify({
		kind: "composed-run",
		createdAt: new Date().toISOString(),
		manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
		caseIds: cases.map(item => item.id),
		catalogue: COMPOSED_TYPES,
		generatorInstructionsSha256: createHash("sha256").update(COMPOSED_GENERATOR_INSTRUCTIONS)
			.digest("hex"),
		generator: "isolated tool-free Copilot SDK HarnessAgent approximation",
		requestedModel,
		requestedJevModel,
		maxPrimaryGenerations: 6,
		maxJevCalls: 20,
	}) + "\n",
	{ flag: "wx" },
);
let generate = modelGenerator({
	harness: "copilot-sdk",
	model: requestedModel,
	token,
	timeoutMs: 90_000,
});
try {
	await runComposed(cases, {
		askJev: (state, questions) =>
			askJev({ state, questions }, { apiKey: key, model: requestedJevModel }),
		generate,
		record: async event => {
			await appendFile(outputPath, JSON.stringify(event) + "\n");
		},
	});
} finally {
	await shutdownHarnesses();
}
console.log(`Recorded composed assessment for ${cases.length} frozen passages`);
