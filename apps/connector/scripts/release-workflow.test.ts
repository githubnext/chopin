import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { binaryName, TARGETS } from "./build-binaries";

/**
 * The release workflow publishes what people install, so its gates are checked here: actionlint
 * when it is installed, and the properties a careless edit could drop without a lint error.
 */
let path = join(import.meta.dir, "../../../.github/workflows/release-cli.yml");

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
};
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
let { build, defender, preflight, publish } = workflow.jobs;
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

	test("publishes only from a tag, after the scan, the preflight and a person's approval", () => {
		expect(publish.needs).toEqual(["build", "defender", "preflight"]);
		expect(publish.if).toBe("github.event_name == 'push'");
		expect(publish.environment).toBe("chopin-cli-release");
	});

	test("checks the approval environment before publishing, with read access only", () => {
		expect(preflight.if).toBe("github.event_name == 'push'");
		expect(preflight.needs).toBeUndefined();
		expect(preflight.permissions).toEqual({ actions: "read" });
		expect(preflight.steps.every(step => !step.uses)).toBe(true);
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

/**
 * GitHub creates an environment that a job names but that does not exist, with no protection, so
 * the preflight job must refuse a missing or unprotected chopin-cli-release. Its script runs here
 * against a fake API that answers as GitHub does for the environment as it is configured.
 */
describe("the release preflight", () => {
	let environment = {
		name: "chopin-cli-release",
		can_admins_bypass: true,
		deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		protection_rules: [
			{
				type: "required_reviewers",
				prevent_self_review: false,
				reviewers: [{ type: "User", reviewer: { login: "lavaman131", id: 57336517 } }],
			},
			{ type: "branch_policy" },
		],
	};
	let tagPolicy = { total_count: 1, branch_policies: [{ name: "cli-v*", type: "tag" }] };
	let settings = "https://github.com/githubnext/chopin/settings/environments";

	/** Runs the preflight step against an API that serves these responses, or 404 for undefined. */
	async function check(responses: { environment?: unknown; policies?: unknown; status?: number }) {
		let base = "/repos/githubnext/chopin/environments/chopin-cli-release";
		let server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.headers.get("authorization") !== "Bearer job-token") {
					return Response.json({ message: "Bad credentials" }, { status: 401 });
				}
				if (responses.status) return Response.json({}, { status: responses.status });
				let path = new URL(request.url).pathname;
				let body = path === base
					? responses.environment
					: path === `${base}/deployment-branch-policies`
					? responses.policies
					: undefined;
				return body === undefined
					? Response.json({ message: "Not Found" }, { status: 404 })
					: Response.json(body);
			},
		});
		try {
			let [step] = preflight.steps;
			let child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
				env: {
					PATH: process.env.PATH,
					...step.env,
					GH_TOKEN: "job-token",
					GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
					GITHUB_SERVER_URL: "https://github.com",
					GITHUB_REPOSITORY: "githubnext/chopin",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			let [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, output: stdout + stderr };
		} finally {
			server.stop(true);
		}
	}

	test("passes when reviewers are required and only cli-v* tags may deploy", async () => {
		let result = await check({ environment, policies: tagPolicy });
		expect(result.output).not.toContain("::error::");
		expect(result.code).toBe(0);
	});

	test("fails when the environment does not exist", async () => {
		let result = await check({});
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("::error::The chopin-cli-release environment does not exist");
		expect(result.output).toContain(settings);
	});

	test("fails when the environment cannot be read", async () => {
		let result = await check({ status: 403 });
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("::error::Could not read the chopin-cli-release environment");
	});

	test("fails without a required reviewer", async () => {
		for (
			let rules of [
				[{ type: "branch_policy" }],
				[{ type: "required_reviewers", reviewers: [] }, { type: "branch_policy" }],
			]
		) {
			let result = await check({
				environment: { ...environment, protection_rules: rules },
				policies: tagPolicy,
			});
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("has no required reviewers");
			expect(result.output).toContain(settings);
		}
	});

	test("fails unless deployments are limited to the cli-v* tag", async () => {
		for (
			let [branchPolicy, policies] of [
				[null, tagPolicy],
				[{ protected_branches: true, custom_branch_policies: false }, tagPolicy],
				[environment.deployment_branch_policy, { total_count: 0, branch_policies: [] }],
				[environment.deployment_branch_policy, {
					total_count: 1,
					branch_policies: [{ name: "cli-v*", type: "branch" }],
				}],
				[environment.deployment_branch_policy, {
					total_count: 2,
					branch_policies: [{ name: "cli-v*", type: "tag" }, { name: "main", type: "branch" }],
				}],
				[environment.deployment_branch_policy, {
					total_count: 1,
					branch_policies: [{ name: "*", type: "tag" }],
				}],
			] as const
		) {
			let result = await check({
				environment: { ...environment, deployment_branch_policy: branchPolicy },
				policies,
			});
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("cli-v*");
			expect(result.output).toContain(settings);
		}
	});
});
