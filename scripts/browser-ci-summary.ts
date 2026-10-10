import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";

let directory = resolve(process.argv[2] ?? "e2e/.scratch/ci-reports");
let suites = [];
let markdown = [
	"## Browser test results",
	"",
	`Head: \`${process.env.CHOPIN_CI_HEAD_SHA ?? "local"}\``,
	`Tested commit: \`${process.env.GITHUB_SHA ?? "local"}\``,
	"",
	"| Suite | Expected | Flaky | Failed | Skipped | Duration |",
	"| --- | --- | --- | --- | --- | --- |",
];
let hasFlaky = false;
for (let name of ["design", "gallery", "integration"]) {
	let source;
	try {
		source = await readFile(join(directory, `${name}.json`), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		suites.push({ name, status: "no-report" });
		markdown.push(`| ${name} | No report | — | — | — | — |`);
		continue;
	}
	let report: JSONReport = JSON.parse(source);
	let issues: {
		title: string;
		file: string;
		line: number;
		project: string;
		status: "flaky" | "unexpected";
		attempts: { status: string | undefined; retry: number; duration: number }[];
	}[] = [];
	function visit(suite: JSONReportSuite, parents: string[]) {
		let titles = /\.(?:e2e|test|spec)\.[cm]?[jt]sx?$/.test(suite.title)
			? parents
			: [...parents, suite.title].filter(Boolean);
		for (let spec of suite.specs) {
			for (let test of spec.tests) {
				if (test.status !== "flaky" && test.status !== "unexpected") continue;
				issues.push({
					title: [...titles, spec.title].join(" › "),
					file: spec.file,
					line: spec.line,
					project: test.projectName,
					status: test.status,
					attempts: test.results.map(({ status, retry, duration }) => ({
						status,
						retry,
						duration,
					})),
				});
			}
		}
		for (let child of suite.suites ?? []) visit(child, titles);
	}
	for (let suite of report.suites) visit(suite, []);
	let { expected, flaky, unexpected, skipped, duration } = report.stats;
	if (![expected, flaky, unexpected, skipped, duration].every(Number.isFinite)) {
		throw new Error(`Invalid browser report counts: ${name}`);
	}
	let errors = report.errors.length;
	suites.push({
		name,
		status: "completed",
		expected,
		flaky,
		unexpected,
		skipped,
		duration,
		errors,
		issues,
	});
	hasFlaky ||= flaky > 0;
	markdown.push(
		`| ${name} | ${expected} | ${flaky} | ${unexpected} | ${skipped} | ${
			(duration / 1000).toFixed(1)
		}s |`,
	);
	if (errors) markdown.push(`\n${name}: ${errors} runner error(s); see the JSON report.\n`);
}
for (let suite of suites) {
	for (let issue of suite.issues ?? []) {
		let title = issue.title.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
		markdown.push(
			`\n- **${issue.status}** ${issue.project}: ${title} (\`${issue.file}:${issue.line}\`)`,
		);
	}
}
let summary = {
	headSha: process.env.CHOPIN_CI_HEAD_SHA ?? null,
	testedSha: process.env.GITHUB_SHA ?? null,
	runId: process.env.GITHUB_RUN_ID ?? null,
	runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
	suites,
};
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
	await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown.join("\n") + "\n");
}
if (process.env.GITHUB_OUTPUT) {
	await appendFile(process.env.GITHUB_OUTPUT, `has_flaky=${hasFlaky}\n`);
}
console.log(markdown.join("\n"));
