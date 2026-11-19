import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { checkouts } from "../../../connector/src/checkouts";
import { endMachineAiLaunch, machineAiLaunch } from "../../../connector/src/machine";
import { createOutput } from "../../../connector/src/output";
import { runWork } from "../../../connector/src/run";
import { createSandbox, inspectSandbox } from "../../../connector/src/sandbox";
import { testGitHubToken } from "../../../connector/src/testing/github-grant";
import { Router } from "../http/router";
import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { AiCredentials } from "./credentials";
import { handOut, RUN_AI_LAUNCH_MS } from "./launches";
import { aiProxy } from "./proxy";

/**
 * A run on a paired machine handed its AI launch, end to end on a real Linux sandbox: Chopin's own
 * credential store and proxy, the connector's request for the launch, its relay and its sandbox,
 * and an agent that calls its model as a coding agent does. Skips, saying why, where the machine
 * has no working sandbox. Everything lives under /var/tmp, because /tmp is private to each sandbox.
 */
let linux = process.platform === "linux";
let scratch = linux ? realpathSync(mkdtempSync("/var/tmp/chopin-ai-handoff-")) : "";
let inspected = linux ? await inspectSandbox({ directory: join(scratch, "inspect") }) : undefined;
let usable = inspected?.report.engine === "bubblewrap";
if (!usable) {
	console.warn("Skipping the AI launch handoff test: this machine has no working sandbox.");
}
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const REAL_KEY = "sk-real-openai-key-0123456789";
const OWNER_KEY = "sk-owner-own-openai-key-0123456789";
const OWNER_LOGIN = "owner-atomic-login-0123456789";
const MACHINE = "chopin_m_machine";

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** A provider standing in for OpenAI: it checks a key once, then answers each completion. */
function provider() {
	let seen: Array<{ path: string; authorization: string | null }> = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			let url = new URL(request.url);
			seen.push({ path: url.pathname, authorization: request.headers.get("authorization") });
			if (url.pathname === "/v1/models") return Response.json({ data: [] });
			return Response.json({
				choices: [{ message: { role: "assistant", content: "hello from the provider" } }],
			});
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

test.skipIf(!usable)(
	"a sandboxed agent reaches its model through Chopin's proxy with only a stand-in, and holds no credential and none of the owner's agent setup",
	async () => {
		let home = join(scratch, "home");
		let checkout = join(scratch, "checkout");
		let state = join(scratch, "state");
		let bin = join(scratch, "bin");
		for (
			let directory of [checkout, state, bin, join(home, ".atomic", "agent"), join(home, ".claude")]
		) {
			mkdirSync(directory, { recursive: true });
		}
		writeFileSync(
			join(home, ".atomic", "agent", "auth.json"),
			JSON.stringify({ token: OWNER_LOGIN }),
		);
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ key: OWNER_KEY }));
		git(checkout, "init", "-b", "main");
		writeFileSync(join(checkout, "README.md"), "the repository\n");
		git(checkout, "add", ".");
		git(checkout, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "initial");
		// Named as GitHub's are, so the connector takes it for a checkout of octo-org/score.
		let remote = join(scratch, "github.com", "octo-org", "score.git");
		mkdirSync(join(scratch, "github.com", "octo-org"), { recursive: true });
		git(scratch, "init", "--bare", remote);
		git(checkout, "remote", "add", "origin", remote);
		// Named as Atomic's ACP command is, so the connector writes it a models.json.
		let agent = join(bin, "atomic-acp");
		writeFileSync(
			agent,
			`#!/bin/sh\nexec ${process.execPath} ${
				join(import.meta.dir, "../../../connector/src/testing/ai-agent.ts")
			}\n`,
		);
		chmodSync(agent, 0o755);

		let openai = provider();
		let storage = new MemoryStorage();
		let now = new Date();
		await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now });
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Release plan",
			createdBy: "U_mona",
			now,
		});
		let router = new Router();
		let ended: string[] = [];
		let handed: Array<{ launchId?: string; launch?: string }> = [];
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(request) {
				let path = new URL(request.url).pathname;
				if (path === "/api/connector/ai-launch") {
					expect(request.headers.get("authorization")).toBe(`Bearer ${MACHINE}`);
					let given = await handOut(credentials, {
						userId: "U_mona",
						channelId: channel.id,
						expiresAt: new Date(Date.now() + RUN_AI_LAUNCH_MS),
					});
					handed.push({
						...given.launchId ? { launchId: given.launchId } : {},
						...given.grants.launch ? { launch: given.grants.launch } : {},
					});
					return Response.json(given.grants);
				}
				if (path === "/api/connector/ai-launch/end") {
					let { launch } = await request.json() as { launch: string };
					let found = handed.find(value => value.launch === launch);
					if (found?.launchId) {
						await credentials.end(found.launchId);
						ended.push(found.launchId);
					}
					return Response.json({ ended: !!found });
				}
				return await router.handle(request) as Response;
			},
		});
		let origin = `http://127.0.0.1:${chopin.port}`;
		let lease = await testLease(storage);
		let credentials = new AiCredentials({
			storage,
			lease: () => lease,
			key: new Uint8Array(32).fill(5),
			origin,
			githubToken: async () => undefined,
			copilotToken: async () => {
				throw new Error("No Copilot here.");
			},
			upstreams: { openai: openai.url },
		});
		router.prefix(
			`${AI_PROXY_PATH}/`,
			aiProxy({ credentials, upstreams: { openai: openai.url } }),
		);
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: REAL_KEY });

		let owned = [
			join(home, ".atomic", "agent", "auth.json"),
			join(home, ".claude", "settings.json"),
		];
		let realHome = process.env.HOME;
		let ownerKey = process.env.ANTHROPIC_API_KEY;
		process.env.HOME = home;
		process.env.ANTHROPIC_API_KEY = OWNER_KEY;
		let sandbox = await createSandbox({ directory: state, home, server: origin });
		try {
			let id = crypto.randomUUID();
			let source = {
				repositoryId: "R_score",
				repository: "octo-org/score",
				commit: git(checkout, "rev-parse", "HEAD"),
			};
			let calls: string[] = [];
			let said = "";
			let api = {
				call: async (name: string, args: unknown) => {
					calls.push(name);
					said += `${name} ${JSON.stringify(args)}\n`;
					return {};
				},
			} as unknown as Parameters<typeof runWork>[0];
			let quiet = {
				write: (text: string) => {
					said += text;
					return true;
				},
			};
			await runWork(
				api,
				"experiment",
				{
					generation: 1,
					runToken: "chopin_r_run",
					input: {
						id,
						documentId: channel.id,
						brief: "Look",
						source,
						context: "",
						requester: "U_mona",
						authorizer: "U_mona",
					},
				},
				{
					checkouts: checkouts({ directory: state, registered: { "octo-org/score": checkout } }),
					directory: state,
					command: [agent],
					url: origin,
					signal: new AbortController().signal,
					output: createOutput(quiet, quiet, {}),
					heartbeatMs: 60_000,
					env: {
						AI_AGENT_REPORT: "ai-report.json",
						AI_AGENT_PEEK: owned.join(","),
						OPENAI_API_KEY: OWNER_KEY,
					},
					github: request => testGitHubToken(request.folder),
					sandbox,
					ai: {
						launch: (run, signal) => machineAiLaunch(origin, MACHINE, run, signal),
						end: launch => endMachineAiLaunch(origin, MACHINE, launch),
					},
				},
			);
			expect(calls, said).toContain("complete_experiment");
			let runs = join(state, "runs");
			let worktree = readdirSync(runs).map(name => join(runs, name)).find(path =>
				existsSync(join(path, "ai-report.json"))
			);
			let report = JSON.parse(readFileSync(join(worktree!, "ai-report.json"), "utf8"));

			// The agent's model answered, through Chopin's proxy, which alone sent the real key.
			expect(report.answer).toMatchObject({
				status: 200,
				body: { choices: [{ message: { content: "hello from the provider" } }] },
			});
			let completions = openai.seen.filter(value => value.path === "/v1/chat/completions");
			expect(completions).toEqual([
				{ path: "/v1/chat/completions", authorization: `Bearer ${REAL_KEY}` },
			]);

			// It was handed a stand-in, its own state directory, and nothing of anyone's credentials.
			let [launch] = handed;
			expect(report.env.OPENAI_API_KEY).toStartWith("chopin_ai_");
			expect(report.env.ATOMIC_CODING_AGENT_DIR).toBe(join(`${worktree}.agent`, "atomic"));
			let held = JSON.stringify({ env: report.env, state: report.state });
			for (let secret of [REAL_KEY, OWNER_KEY, OWNER_LOGIN, launch!.launch!]) {
				expect(held).not.toContain(secret);
			}
			let models = JSON.parse(report.state[join(`${worktree}.agent`, "atomic", "models.json")]);
			expect(models.providers.openai).toEqual({
				baseUrl: report.env.OPENAI_BASE_URL,
				apiKey: "$OPENAI_API_KEY",
			});
			// The owner's own agents' logins and settings are out of its sight.
			for (let path of owned) {
				expect(report.peeked[path], path).toHaveProperty("error");
				expect(report.peeked[path], path).not.toHaveProperty("text");
			}
			// The run's end ended its launch: the stand-in reaches nothing now.
			expect(ended).toEqual([launch!.launchId!]);
			let after = await fetch(`${origin}${AI_PROXY_PATH}/openai/v1/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${report.env.OPENAI_API_KEY}`,
					"x-chopin-launch": launch!.launch!,
				},
				body: "{}",
			});
			expect(after.status).toBe(401);
		} finally {
			process.env.HOME = realHome;
			if (ownerKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = ownerKey;
			await sandbox.close();
			await chopin.stop(true);
			openai.stop();
		}
	},
	120_000,
);
