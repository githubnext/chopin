import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { askJev } from "../conversation-plan/jev";
import { shutdownHarnesses } from "../harness/harnesses";
import { CHOICES } from "./catalogue";
import { JEV_QUESTION, runCase } from "./experiment";
import { modelGenerator } from "./model";
import { loadCases } from "./source";

import type { ModelSettings } from "./model";

let exec = promisify(execFile);

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

async function githubToken(): Promise<string | undefined> {
	if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
		return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	}
	try {
		let { stdout } = await exec("gh", ["auth", "token"], { encoding: "utf8" });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	let mode = process.argv.includes("--jev-probe") ? "jev-probe" : "baseline";
	let registryPath = option("--registry");
	let manifestPath = option("--manifest") ?? "evals/visual-selection/cases.json";
	let outputPath = option("--output");
	let caseId = option("--case");
	if (!registryPath || !outputPath) {
		throw new Error(
			"Provide --registry <frozen development registry> and --output <new JSONL path>",
		);
	}
	let cases = await loadCases(manifestPath, registryPath);
	if (caseId) cases = cases.filter(item => item.cluster === caseId);
	if (cases.length === 0) throw new Error(`No selected case: ${caseId}`);
	if (mode === "jev-probe" && cases.length !== 1) {
		throw new Error("--jev-probe requires --case <development discussion ID>");
	}
	let key = await jevKey(option("--jev-env"));
	if (!key) throw new Error("Jev access unavailable: set JEV_API_KEY or pass --jev-env");
	let harness = (option("--harness") ?? "copilot-sdk") as ModelSettings["harness"];
	if (!["copilot-sdk", "pi", "atomic"].includes(harness)) throw new Error("Unsupported harness");
	let requestedModel = option("--model") ?? "gpt-6-luna";
	let auth = option("--auth");
	let token = mode === "baseline" && harness === "copilot-sdk"
		? await githubToken()
		: undefined;
	if (mode === "baseline" && harness === "copilot-sdk" && !token) {
		throw new Error(
			"Model access unavailable: copilot-sdk needs a GitHub user token in the environment or gh keyring",
		);
	}
	if (mode === "baseline" && harness !== "copilot-sdk" && !auth) {
		throw new Error(`Model access unavailable: --auth is required for ${harness}`);
	}
	await mkdir(dirname(outputPath), { recursive: true });
	let registrySha256 = createHash("sha256").update(await readFile(registryPath)).digest("hex");
	await writeFile(
		outputPath,
		JSON.stringify({
			kind: "run",
			mode,
			createdAt: new Date().toISOString(),
			manifestPath,
			registrySha256,
			caseIds: cases.map(item => item.id),
			catalogue: CHOICES,
			generator: "isolated tool-free harness approximation of Planner selection and generation",
			harness: mode === "baseline" ? harness : null,
			requestedModel: mode === "baseline" ? requestedModel : null,
			jevRequestedModel: process.env.JEV_MODEL ?? "jev-latest",
		}) + "\n",
		{ flag: "wx" },
	);
	let record = async (event: object) => {
		await appendFile(outputPath, JSON.stringify(event) + "\n");
	};
	let callJev = async (input: object) =>
		askJev({ state: input, questions: JEV_QUESTION }, {
			apiKey: key,
			model: process.env.JEV_MODEL ?? "jev-latest",
		});
	if (mode === "jev-probe") {
		try {
			let result = await callJev(cases[0]!.input);
			await record({ kind: "jev", caseId: cases[0]!.id, result });
			console.log(`Jev probe: ${cases[0]!.id}; model ${result.model}; ${result.latencyMs} ms`);
		} catch (error) {
			await record({ kind: "jev-error", caseId: cases[0]!.id, error: String(error) });
			throw error;
		}
		return;
	}
	let generate = modelGenerator({ harness, auth, model: requestedModel, token, timeoutMs: 90_000 });
	try {
		for (let source of cases) {
			await runCase(source, { askJev: callJev, generate, record });
			console.log(`Recorded three strategies for ${source.id}`);
		}
	} finally {
		await shutdownHarnesses();
	}
}

await main();
