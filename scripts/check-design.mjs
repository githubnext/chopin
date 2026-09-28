#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let web = join(root, "apps/web");
let baseline = JSON.parse(readFileSync(join(root, "scripts/impeccable-baseline.json"), "utf8"));
let targets = [
	"index.html",
	"src",
	"../../packages/editor/src",
	"../../packages/visuals/src",
	"../../packages/visuals/theme.css",
	"../../packages/question/src",
	"../../packages/icons/src",
];
let scan = spawnSync(
	join(root, "node_modules/.bin/impeccable"),
	["detect", "--json", ...targets],
	{ cwd: web, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);

if (scan.error || ![0, 2].includes(scan.status)) {
	console.error(scan.error ?? scan.stderr ?? `Impeccable scan failed (${scan.status}).`);
	process.exit(1);
}

let findings;
try {
	findings = JSON.parse(scan.stdout);
	if (!Array.isArray(findings)) throw new Error("Expected an array of findings.");
} catch (error) {
	console.error("Impeccable returned invalid JSON:", error);
	process.exit(1);
}

function key({ rule, file, snippet }) {
	return JSON.stringify([rule, file, snippet]);
}

let current = new Map();
for (let finding of findings) {
	let file = relative(root, finding.file).split(sep).join("/");
	if (file.startsWith("../") || file === "..") {
		console.error(`Impeccable reported a file outside the repository: ${finding.file}`);
		process.exit(1);
	}
	let entry = { rule: finding.antipattern, file, snippet: finding.snippet };
	let fingerprint = key(entry);
	let previous = current.get(fingerprint);
	current.set(fingerprint, { ...entry, count: (previous?.count ?? 0) + 1 });
}

let allowed = new Map();
if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.findings)) {
	console.error("Invalid Impeccable baseline file.");
	process.exit(1);
}
for (let entry of baseline.findings) {
	let fingerprint = key(entry);
	if (allowed.has(fingerprint) || !Number.isInteger(entry.count) || entry.count < 1) {
		console.error(`Invalid or repeated Impeccable baseline entry: ${fingerprint}`);
		process.exit(1);
	}
	allowed.set(fingerprint, entry);
}

let changes = [];
for (let [fingerprint, entry] of current) {
	let oldCount = allowed.get(fingerprint)?.count ?? 0;
	if (entry.count > oldCount) {
		changes.push(
			`NEW ${entry.rule} in ${entry.file}: ${entry.snippet} (${entry.count - oldCount})`,
		);
	}
}
for (let [fingerprint, entry] of allowed) {
	let newCount = current.get(fingerprint)?.count ?? 0;
	if (newCount < entry.count) {
		changes.push(`STALE baseline ${entry.rule} in ${entry.file}: ${entry.snippet}`);
	}
}

if (changes.length) {
	console.error(changes.join("\n"));
	console.error("Fix new findings; reduce the baseline when existing findings are fixed.");
	process.exit(1);
}

console.log(`Impeccable: no new findings (${findings.length} existing baseline findings).`);
