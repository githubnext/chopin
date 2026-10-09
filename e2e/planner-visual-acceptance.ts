import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { plannerInstructions } from "../apps/server/src/agent/planner";
import {
	PLANNER_TOOL_NAMES,
	VISUAL_PLANNER_TOOL_NAMES,
} from "../apps/server/src/harness/tool-names";
import {
	cases,
	cohortSha256,
	datasetManifestSha256,
	materialize,
} from "../evals/planner-visual/cohort";

export { materialize };

export const APP_PORT = 8870;
export const MCP_PORT = 8871;
export const DATABASE_PORT = "8872";
const NATIVE_FIVE_SHA256 = "6ff0cd452be09b438f93b7dcc6180f5f8737a11f8c7b391311c23f331d5064d7";
const JEV_THREE_SHA256 = "41ff5f050bb98541179af1e3bdc23c50440e1fff3648669e71331ef2cab235fa";

function required(name: string): string {
	let value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for Planner visual acceptance`);
	return value;
}

export function loadAcceptance() {
	if (process.env.E2E_PLANNER_VISUAL_ACCEPTANCE !== "1") {
		throw new Error("Set E2E_PLANNER_VISUAL_ACCEPTANCE=1 to allow real Planner turns");
	}
	let selected = required("E2E_VISUAL_CASE_IDS").split(",").map(id => id.trim());
	if (selected.length < 1 || selected.length > 6 || new Set(selected).size !== selected.length) {
		throw new Error("Select 1–6 distinct frozen case IDs for one bounded batch");
	}
	let chosen = selected.map(id => {
		let entry = cases.find(item => item.caseId === id);
		if (!entry) throw new Error(`Unsupported frozen development case: ${id}`);
		return entry;
	});
	let subsetName = required("E2E_VISUAL_SUBSET");
	let visualRouting = subsetName === "jev-three-development-v1";
	if (!visualRouting && subsetName !== "native-five-development-v1") {
		throw new Error("Select a frozen Planner visual development subset");
	}
	let subsetPath = visualRouting ? "jev-three-v1.json.freeze" : "native-five-v1.json.freeze";
	let subsetSha256 = visualRouting ? JEV_THREE_SHA256 : NATIVE_FIVE_SHA256;
	let subsetBytes = readFileSync(
		new URL(`../evals/planner-visual/${subsetPath}`, import.meta.url),
	);
	let sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
	if (sha256(subsetBytes) !== subsetSha256) {
		throw new Error("Planner visual subset freeze changed");
	}
	let subset = JSON.parse(subsetBytes.toString("utf8")) as {
		version: string;
		parentCohortSha256: string;
		rubric: string;
		axes: string[];
		cases: { id: string; sourceSha256: string; promptSha256: string }[];
	};
	if (
		subset.version !== subsetName
		|| subset.parentCohortSha256 !== cohortSha256
		|| subset.rubric !== "native-mdx-v3"
		|| subset.axes.join("|") !== [
				"presentation fit",
				"source fidelity",
				"semantic usefulness",
				"persistence and rendering",
			].join("|")
		|| subset.cases.length !== selected.length
		|| subset.cases.some((item, index) =>
			item.id !== chosen[index]?.caseId
			|| item.sourceSha256 !== chosen[index]?.sourceSha256
			|| item.promptSha256 !== chosen[index]?.promptSha256
		)
	) throw new Error("Selected cases or rubric differ from the frozen subset");
	let runId = required("E2E_VISUAL_RUN_ID");
	if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(runId)) {
		throw new Error("E2E_VISUAL_RUN_ID must be a short lowercase slug");
	}
	let phase = required("E2E_VISUAL_PHASE");
	if (visualRouting ? phase !== "jev-candidate" : phase !== "baseline" && phase !== "correction") {
		throw new Error("E2E_VISUAL_PHASE does not match the frozen subset");
	}
	let model = required("E2E_VISUAL_MODEL");
	let questionAnswer = visualRouting ? undefined : required("E2E_VISUAL_QUESTION_ANSWER");
	let jevModel = visualRouting ? required("JEV_MODEL") : undefined;
	if (
		visualRouting && (
			model !== "gpt-6-luna" || jevModel !== "jev-1.13.0"
			|| !process.env.JEV_API_KEY || process.env.E2E_VISUAL_QUESTION_ANSWER
		)
	) throw new Error("Jev-three requires the pinned models, JEV_API_KEY, and no answer control");
	let repository = fileURLToPath(new URL("../", import.meta.url));
	let commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })
		.trim();
	let changes = execFileSync("git", ["status", "--porcelain"], {
		cwd: repository,
		encoding: "utf8",
	}).trim();
	if (changes) throw new Error("Commit the acceptance checkout before a real Planner run");
	let guidance = plannerInstructions("octo-org/score", undefined, undefined, visualRouting);
	let outputRoot = join(repository, "e2e/test-results/planner-visual-acceptance", runId);
	let configuration = {
		version: visualRouting ? 4 : 3,
		phase,
		datasetManifestSha256,
		cohortSha256,
		subsetSha256,
		caseIds: selected,
		commit,
		model,
		harness: "copilot-sdk",
		harnessAuth: "direct",
		toolNames: visualRouting ? VISUAL_PLANNER_TOOL_NAMES : PLANNER_TOOL_NAMES,
		generationSettings: {
			temperature: "SDK default; no override",
			topP: "SDK default; no override",
			maxOutputTokens: "SDK default; no override",
			streaming: true,
			largeOutput: false,
		},
		questionAnswer,
		...(visualRouting && {
			visualRouting: true,
			jevModel,
			jevTimeoutMs: 30_000,
			jevDecisionThresholds: { possibility: 0.5, helpfulness: 0.5 },
			jevRequestCap: { perCase: 3, total: 9 },
			visualCodeSha256: Object.fromEntries([
				"visual-routing.ts",
				"visual-catalog.ts",
				"visual-handoff.ts",
				"visual-receipt.ts",
				"visual-authoring.ts",
				"planner.ts",
			].map(name => [
				name,
				sha256(readFileSync(new URL(`../apps/server/src/agent/${name}`, import.meta.url))),
			])),
		}),
		previewProvider: "unavailable",
		authoringSurface: "native-mdx-v3",
		repository: "octo-org/score",
		ports: { app: APP_PORT, mcp: MCP_PORT, database: Number(DATABASE_PORT) },
		guidanceSha256: sha256(guidance),
		guidance,
	};
	let text = JSON.stringify(configuration, null, 2) + "\n";
	mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
	let configPath = join(outputRoot, "run-config.json");
	if (existsSync(configPath)) {
		if (readFileSync(configPath, "utf8") !== text) {
			throw new Error("Frozen run configuration changed; use a new run ID before output");
		}
	} else {
		writeFileSync(configPath, text, { flag: "wx", mode: 0o600 });
	}
	return {
		cases: chosen,
		runId,
		outputRoot,
		configSha256: sha256(text),
		configuration,
	};
}
