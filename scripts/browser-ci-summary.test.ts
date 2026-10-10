import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("browser summaries preserve retry identity, missing reports and tested revisions", async () => {
	let directory = await mkdtemp(join(tmpdir(), "chopin-browser-summary-"));
	try {
		await writeFile(
			join(directory, "integration.json"),
			JSON.stringify({
				stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 1, duration: 4000 },
				errors: [],
				suites: [{
					title: "navigation.e2e.ts",
					specs: [],
					suites: [{
						title: "navigation",
						specs: [{
							title: "restores focus",
							file: "navigation.e2e.ts",
							line: 42,
							tests: [{
								projectName: "chromium",
								status: "flaky",
								results: [{
									status: "failed",
									retry: 0,
									duration: 2000,
								}, { status: "passed", retry: 1, duration: 500 }],
							}],
						}],
					}],
				}],
			}),
		);
		let child = Bun.spawn([
			process.execPath,
			join(import.meta.dir, "browser-ci-summary.ts"),
			directory,
		], {
			env: {
				...process.env,
				CHOPIN_CI_HEAD_SHA: "reviewed-head",
				GITHUB_SHA: "tested-merge",
				GITHUB_OUTPUT: join(directory, "outputs"),
				GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		let stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
		let summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
		expect(summary).toMatchObject({ headSha: "reviewed-head", testedSha: "tested-merge" });
		expect(summary.suites).toContainEqual({ name: "design", status: "no-report" });
		expect(summary.suites).toContainEqual({ name: "gallery", status: "no-report" });
		expect(summary.suites[2]).toMatchObject({
			name: "integration",
			flaky: 1,
			unexpected: 1,
			skipped: 1,
			issues: [{
				title: "navigation › restores focus",
				file: "navigation.e2e.ts",
				line: 42,
				project: "chromium",
				status: "flaky",
				attempts: [
					{ status: "failed", retry: 0, duration: 2000 },
					{ status: "passed", retry: 1, duration: 500 },
				],
			}],
		});
		expect(await readFile(join(directory, "outputs"), "utf8")).toContain("has_flaky=true");
		expect(await readFile(join(directory, "step-summary"), "utf8")).toContain("restores focus");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
