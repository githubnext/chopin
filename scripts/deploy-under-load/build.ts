/**
 * A build that runs across the deploys: the real connector (`apps/connector`), paired with a key
 * and given a checkout, runs the fake implementer of the connector's own tests as its coding
 * agent. The agent starts the first task and waits at a file until the run says to go on, so the
 * build is running while Chopin is deployed; once let go it must finish Built, with the pull
 * requests it reported, as `e2e/build-restart.e2e.ts` holds one to across a restart.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createChannel, seedChannel } from "../../e2e/database";
import { mintPairingKey } from "./planner";
import { signIn } from "./session";

import type { ChildProcess } from "node:child_process";
import type { Graph } from "../../apps/server/src/tasks/graphs";
import { outcomeOf } from "./analysis";

import type { BuildOutcome, BuildSnapshot } from "./analysis";
import type { Environment } from "./environment";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILDER = "ana";
const TASKS = ["connect", "review"];

function graph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: TASKS[0]!,
					title: "Connect the local agent",
					context: "An isolated tracer.",
					goal: "Report through MCP across the deploys.",
					acceptance: ["The agent can read the graph.", "Its reports reach Chopin."],
					dependsOn: [],
				}, {
					id: TASKS[1]!,
					title: "Review the connection",
					context: "Wait for the connection.",
					goal: "Verify progress survives the deploys.",
					acceptance: ["The progress persists.", "The dependency is visible."],
					dependsOn: [TASKS[0]!],
				}],
			},
		}],
	};
}

export type Build = {
	/** Lets the agent go on, and resolves with how the build ended and what it reported. */
	finish(): Promise<BuildOutcome>;
	/** What the connector said, for a failure. */
	output(): string;
	stop(): Promise<void>;
};

type Snapshot = BuildSnapshot & {
	planRevision: number;
	graph?: { number: number; revision: number };
};

/** Starts the connector and the build, and returns once the agent is running its first task. */
export async function startBuild(env: Environment): Promise<Build> {
	let cookie = await signIn(env.origin, BUILDER);
	let key = await mintPairingKey(env.origin, cookie, BUILDER);
	let room = crypto.randomUUID();
	await createChannel(env.port, room);
	await seedChannel(env.port, room, "# Build under load\n\nBuild through the deploys.\n", {
		graph: graph(),
	});
	let directories = [
		await mkdtemp(join(tmpdir(), "chopin-load-checkout-")),
		await mkdtemp(join(tmpdir(), "chopin-load-state-")),
		await mkdtemp(join(tmpdir(), "chopin-load-signals-")),
	];
	let [checkout, state, signals] = directories as [string, string, string];
	let git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, "-c", "commit.gpgsign=false", ...args], {
			stdio: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(checkout, "sample.txt"), "committed source");
	git("add", ".");
	git("commit", "-m", "fixture");
	let paused = join(signals, "paused");
	let resume = join(signals, "resume");
	let connector: ChildProcess = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		checkout,
		"--key",
		key,
		"--",
		"bun",
		join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
		"--complete",
		"--http",
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			CHOPIN_URL: env.origin,
			CHOPIN_CONNECTOR_STATE_DIR: state,
			CHOPIN_TEST_PAUSED: paused,
			CHOPIN_TEST_RESUME: resume,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	connector.stdout?.on("data", chunk => output = (output + String(chunk)).slice(-20_000));
	connector.stderr?.on("data", chunk => output = (output + String(chunk)).slice(-20_000));
	let endpoint = `${env.origin}/api/channels/${room}/implementation`;
	let snapshot = async (): Promise<Snapshot> =>
		await (await fetch(endpoint, { headers: { cookie }, signal: AbortSignal.timeout(20_000) }))
			.json() as Snapshot;
	let stop = async () => {
		if (connector.pid !== undefined && connector.exitCode === null) {
			let exit = new Promise<void>(resolve => connector.once("close", () => resolve()));
			process.kill(-connector.pid, "SIGTERM");
			await Promise.race([exit, Bun.sleep(5_000)]);
			if (connector.exitCode === null) process.kill(-connector.pid, "SIGKILL");
		}
		for (let directory of directories) await rm(directory, { recursive: true, force: true });
	};
	try {
		// The connector pairs and connects before Chopin will start a build on it.
		let started = false;
		for (let attempt = 0; attempt < 60 && !started; attempt++) {
			if (connector.exitCode !== null) {
				throw new Error(`the connector exited ${connector.exitCode}:\n${output}`);
			}
			let current = await snapshot();
			let response = await fetch(endpoint, {
				method: "POST",
				headers: { cookie, origin: env.origin, "content-type": "application/json" },
				body: JSON.stringify({
					planRevision: current.planRevision,
					graphVersion: current.graph?.number ?? 1,
					graphRevision: current.graph?.revision ?? 1,
				}),
			});
			started = response.ok;
			if (!started) await Bun.sleep(500);
		}
		if (!started) throw new Error(`the build did not start:\n${output}`);
		for (let attempt = 0; attempt < 120 && !existsSync(paused); attempt++) await Bun.sleep(250);
		if (!existsSync(paused)) throw new Error(`the agent did not start its first task:\n${output}`);
	} catch (error) {
		await stop();
		throw error;
	}
	return {
		output: () => output,
		stop,
		async finish() {
			await writeFile(resume, "");
			let last: Snapshot = { planRevision: 0 };
			for (let attempt = 0; attempt < 360; attempt++) {
				last = await snapshot();
				if (last.build?.state === "stopped" || last.build?.state === "failed") break;
				await Bun.sleep(250);
			}
			await stop();
			return outcomeOf(last, TASKS);
		},
	};
}
