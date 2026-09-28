#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let targets = [
	"index.html",
	"src",
	"../../packages/editor/src",
	"../../packages/visuals/src",
	"../../packages/visuals/theme.css",
	"../../packages/question/src",
	"../../packages/icons/src",
];

export function scanDesign(root, run = spawnSync) {
	return run(
		join(root, "node_modules/.bin/impeccable"),
		["detect", "--json", "--no-inline-ignores", ...targets],
		{ cwd: join(root, "apps/web"), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
}

function key({ rule, file, snippet }) {
	return JSON.stringify([rule, file, snippet]);
}

function text(value) {
	return typeof value === "string" && value.trim().length > 0;
}

export function designProblems(scan, baseline, root) {
	if (scan.error || ![0, 2].includes(scan.status)) {
		throw new Error(
			`Impeccable scan failed (${scan.status}): ${
				scan.error?.message || scan.stderr || "no diagnostic returned"
			}`,
		);
	}
	let findings;
	try {
		findings = JSON.parse(scan.stdout);
	} catch {
		throw new Error("Impeccable returned invalid JSON.");
	}
	if (!Array.isArray(findings)) throw new Error("Expected an array of Impeccable findings.");

	let current = new Map();
	for (let finding of findings) {
		if (
			!finding || !text(finding.antipattern) || !text(finding.file) || !text(finding.snippet)
			|| !isAbsolute(finding.file)
		) throw new Error("Invalid Impeccable finding: expected rule, absolute file, and snippet.");
		let file = relative(root, finding.file).split(sep).join("/");
		if (!file || file.startsWith("../") || file === ".." || isAbsolute(file)) {
			throw new Error(`Impeccable reported a file outside the repository: ${finding.file}`);
		}
		let entry = { rule: finding.antipattern, file, snippet: finding.snippet };
		let fingerprint = key(entry);
		let previous = current.get(fingerprint);
		current.set(fingerprint, { ...entry, count: (previous?.count ?? 0) + 1 });
	}

	let allowed = new Map();
	if (!baseline || baseline.schemaVersion !== 1 || !Array.isArray(baseline.findings)) {
		throw new Error("Invalid Impeccable baseline file.");
	}
	for (let entry of baseline.findings) {
		if (
			!entry || !text(entry.rule) || !text(entry.file) || !text(entry.snippet)
			|| !text(entry.reason) || !Number.isInteger(entry.count) || entry.count < 1
			|| isAbsolute(entry.file) || entry.file.includes("\\")
			|| relative(root, resolve(root, entry.file)).split(sep).join("/") !== entry.file
			|| entry.file.startsWith("../") || entry.file === ".."
		) throw new Error("Invalid Impeccable baseline entry: exact path, count, and reason required.");
		let fingerprint = key(entry);
		if (allowed.has(fingerprint)) {
			throw new Error(`Repeated Impeccable baseline entry: ${fingerprint}`);
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
	return { changes, count: findings.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		let baseline = JSON.parse(readFileSync(join(root, "scripts/impeccable-baseline.json"), "utf8"));
		let result = designProblems(scanDesign(root), baseline, root);
		if (result.changes.length) {
			throw new Error(
				result.changes.join("\n")
					+ "\nFix new findings; reduce the baseline when existing findings are fixed.",
			);
		}
		console.log(`Impeccable: no new findings (${result.count} existing baseline findings).`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
