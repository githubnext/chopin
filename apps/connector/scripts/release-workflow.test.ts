import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { binaryName, TARGETS } from "./build-binaries";

/**
 * The release workflow publishes what people install, so its gates are checked here: actionlint
 * when it is installed, and the properties a careless edit could drop without a lint error.
 */
let path = join(import.meta.dir, "../../../.github/workflows/release-cli.yml");

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
	needs?: string | string[];
	if?: string;
	"runs-on": string;
	environment?: string | { name: string };
	permissions?: Record<string, string>;
	steps: Step[];
};
type Workflow = {
	on: {
		push?: { tags?: string[]; branches?: string[] };
		workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
	};
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
};

let source = await Bun.file(path).text();
let workflow = Bun.YAML.parse(source) as Workflow;
let { build, defender, publish } = workflow.jobs;
let script = (job: Job) => job.steps.map(step => step.run ?? "").join("\n");
let uses = (job: Job, action: string) =>
	job.steps.filter(step => step.uses?.startsWith(`${action}@`));

let actionlint = Bun.which("actionlint");
test.skipIf(!actionlint)("passes actionlint", () => {
	let result = Bun.spawnSync([actionlint!, path], { stdout: "pipe", stderr: "pipe" });
	expect(result.stdout.toString() + result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
});

describe("the CLI release workflow", () => {
	test("runs for cli-v* tags, or as a dry run for a version", () => {
		expect(workflow.on.push).toEqual({ tags: ["cli-v*"] });
		expect(workflow.on.workflow_dispatch?.inputs?.version?.required).toBe(true);
	});

	test("pins every action to a version tag", () => {
		let all = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses);
		expect(all.length).toBeGreaterThan(0);
		for (let step of all) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@v\d+(\.\d+){0,2}$/);
	});

	test("grants write access only to the publish job", () => {
		expect(workflow.permissions).toEqual({});
		expect(build.permissions).toEqual({ contents: "read" });
		expect(defender.permissions).toEqual({});
		expect(publish.permissions).toEqual({
			contents: "write",
			"id-token": "write",
			attestations: "write",
		});
	});

	test("builds every binary from a tag that matches the package version", () => {
		expect(script(build)).toContain("apps/connector/package.json");
		expect(script(build)).toContain("build:binaries");
		expect(script(build)).toContain("sha256sum");
		expect(script(build)).toContain("checksums.txt");
		expect(uses(build, "actions/upload-artifact")).toHaveLength(1);
	});

	test("scans each Windows binary with updated Microsoft Defender signatures", () => {
		expect(defender["runs-on"]).toBe("windows-latest");
		expect(defender.needs).toBe("build");
		let scan = script(defender);
		expect(scan).toContain("checksums.txt");
		expect(scan).toContain("-SignatureUpdate");
		expect(scan).toContain("MpCmdRun");
		expect(scan).toContain("-Scan -ScanType 3 -File");
	});

	test("publishes only from a tag, after the scan and a person's approval", () => {
		expect(publish.needs).toEqual(["build", "defender"]);
		expect(publish.if).toBe("github.event_name == 'push'");
		expect(publish.environment).toBe("chopin-cli-release");
	});

	test("attests every binary, and keeps audited SBOMs as workflow artifacts", () => {
		let [attest] = uses(publish, "actions/attest-build-provenance");
		expect(attest?.with?.["subject-path"]).toBe(
			TARGETS.map(target => `release/${binaryName(target)}`).join("\n"),
		);
		let formats = uses(publish, "anchore/sbom-action").map(step => step.with?.format);
		expect(formats).toEqual(["spdx-json", "cyclonedx-json"]);
		let steps = publish.steps.map(step => step.uses ?? step.run ?? "");
		let audit = steps.findIndex(step => step.includes("PRIVATE KEY"));
		let release = steps.findIndex(step => step.includes("gh release create"));
		expect(audit).toBeGreaterThan(steps.findLastIndex(step => step.startsWith("anchore/")));
		expect(release).toBeGreaterThan(audit);
		expect(release).toBeGreaterThan(steps.findIndex(step => step.startsWith("actions/attest")));
	});

	test("releases the five binaries, checksums.txt and both install scripts", () => {
		let create = publish.steps.find(step => step.run?.includes("gh release create"))?.run ?? "";
		expect(create).toContain('"cli-v$VERSION"');
		for (let target of TARGETS) expect(create).toContain(`release/${binaryName(target)}`);
		for (let file of ["checksums.txt", "install.sh", "install.ps1"]) {
			expect(create).toContain(`release/${file}`);
		}
	});
});
