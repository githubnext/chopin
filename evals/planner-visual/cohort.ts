import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { listCases, loadCase } from "../datasets/v2";

const FREEZE_SHA256 = "bb7b2135ef838f12a28fb095b9f2a85423f40461c4281423d4c43cda69a85e0b";
const MANIFEST_SHA256 = "62b3f984f8761ddfd6b4e8a5770e5256847b269c92f00fab168c581408385cbe";
const DATASET_COMMIT = "680b4ca87cbda379ca9fe78fe1dc4839dbef231f";

export type FrozenCase = {
	caseId: string;
	loaderId: string;
	checkpointId: string | null;
	origin: "original-source" | "adapted" | "synthetic";
	sourceCluster: string;
	cutoff: string;
	loaderFileSha256: string;
	loaderOutputSha256: string;
	sourceText: string;
	sourceSha256: string;
	promptText: string;
	promptSha256: string;
};

export type AcceptanceCase = {
	id: string;
	origin: FrozenCase["origin"];
	sourceCluster: string;
	cutoff: string;
	loaderId: string;
	checkpointId: string | null;
	loaderOutputSha256: string;
	source: string;
	prompt: string;
	sourceSha256: string;
	promptSha256: string;
};

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

let freezeBytes = readFileSync(new URL("./cohort-v2.json.freeze", import.meta.url));
if (sha256(freezeBytes) !== FREEZE_SHA256) throw new Error("Planner cohort freeze changed");
let frozen = JSON.parse(freezeBytes.toString("utf8")) as {
	version: string;
	datasetCommit: string;
	manifestSha256: string;
	cases: FrozenCase[];
};
let manifestBytes = readFileSync(new URL("../datasets/v2/manifest.json", import.meta.url));
if (
	frozen.version !== "planner-visual-development-v2-proposed"
	|| frozen.datasetCommit !== DATASET_COMMIT
	|| frozen.manifestSha256 !== MANIFEST_SHA256
	|| sha256(manifestBytes) !== MANIFEST_SHA256
	|| frozen.cases.length !== 10
) throw new Error("Planner cohort is not bound to the reviewed development dataset");

let manifest = JSON.parse(manifestBytes.toString("utf8")) as {
	cases: { id: string; file: { sha256: string } }[];
};
let available = new Map(listCases().map(item => [item.id, item]));
let ids = new Set<string>();
for (let item of frozen.cases) {
	let source = available.get(item.loaderId);
	let entry = manifest.cases.find(candidate => candidate.id === item.loaderId);
	if (
		ids.has(item.caseId) || !source || !entry
		|| source.origin !== item.origin
		|| source.sourceCluster !== item.sourceCluster
		|| entry.file.sha256 !== item.loaderFileSha256
		|| (item.checkpointId !== null && !source.checkpoints.includes(item.checkpointId))
		|| (item.checkpointId === null && source.kind !== "authored-proposal")
		|| sha256(item.sourceText) !== item.sourceSha256
		|| sha256(item.promptText) !== item.promptSha256
	) throw new Error(`Planner cohort case changed: ${item.caseId}`);
	ids.add(item.caseId);
}

export const cases = frozen.cases;
export const cohortSha256 = FREEZE_SHA256;
export const datasetManifestSha256 = MANIFEST_SHA256;

/** Reconstruct the document seed from the verified loader, then compare frozen bytes. */
export async function materialize(item: FrozenCase): Promise<AcceptanceCase> {
	let input = await loadCase(item.loaderId, item.checkpointId ?? undefined);
	if (sha256(JSON.stringify(input)) !== item.loaderOutputSha256) {
		throw new Error(`Loaded development input changed: ${item.caseId}`);
	}
	let title = "# Source-grounded explanation\n\n## Development input\n\n";
	let source: string;
	if (input.kind === "authored-proposal") {
		let ranges = item.caseId === "R1"
			? [[61, 98], [122, 138]]
			: item.caseId === "R2"
			? [[122, 138], [232, 249]]
			: undefined;
		if (!ranges) throw new Error(`Unexpected proposal slice: ${item.caseId}`);
		let lines = input.text.split("\n");
		let slices = ranges.map(([start, end]) =>
			`### RFC lines ${start}–${end}\n\n${lines.slice(start! - 1, end).join("\n")}`
		);
		source = title
			+ `Origin: original-source Rust RFC excerpt\nCutoff: ${input.cutoff}\n\n${
				slices.join("\n\n")
			}\n`;
	} else if (input.kind === "async-discussion") {
		let events = input.events.map(event =>
			`- ${event.createdAt} · ${
				String(event.actor)
			} · ${event.kind} · ${event.id}: ${event.summary}`
		);
		source = title
			+ `Origin: adapted event summaries from a public discussion\nSource: ${input.sourceUrl}\nCutoff: ${input.cutoff}\n\n${
				events.join("\n")
			}\n`;
	} else {
		let messages = input.steps.filter(step => step.kind === "say")
			.map(step => `[${step.actor}] ${step.text}`);
		source = title
			+ `Origin: synthetic development chat\nCheckpoint: ${input.checkpointId}\n\n${
				messages.join("\n\n")
			}\n`;
	}
	if (source !== item.sourceText || sha256(source) !== item.sourceSha256) {
		throw new Error(`Frozen document seed changed: ${item.caseId}`);
	}
	return {
		id: item.caseId,
		origin: item.origin,
		sourceCluster: item.sourceCluster,
		cutoff: item.cutoff,
		loaderId: item.loaderId,
		checkpointId: item.checkpointId,
		loaderOutputSha256: item.loaderOutputSha256,
		source,
		prompt: item.promptText,
		sourceSha256: item.sourceSha256,
		promptSha256: item.promptSha256,
	};
}
