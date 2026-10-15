import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { options } from "./options";
import { repositoryFiles, scenarioHash, scenarios, select } from "./scenarios";
import { hash, sanitizer } from "./sanitize";
import { markdown, scorecard } from "./review";
import type { Transcript } from "./types";

async function command(args: string[]): Promise<string> {
	let child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	let [stdout, _stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${args[0]} failed (${code}); credential output withheld`);
	return stdout.trim();
}

async function gitState() {
	let [head, status, diff, untracked] = await Promise.all([
		command(["git", "rev-parse", "HEAD"]),
		command(["git", "status", "--porcelain=v1"]),
		command(["git", "diff", "HEAD", "--binary"]),
		command(["git", "ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	let paths = untracked ? untracked.split("\0").filter(Boolean).sort() : [];
	let files = await Promise.all(
		paths.map(async path => ({ path, hash: hash(await readFile(path)) })),
	);
	return { head, dirty: !!status, dirtyDiffHash: hash(JSON.stringify({ status, diff, files })) };
}

async function main() {
	let settings = options(process.argv.slice(2));
	if (settings.list) {
		console.log(scenarios.map(item => `${item.id}\t${item.title}`).join("\n"));
		return;
	}
	let selected = select(settings.cases);
	if (!settings.live) {
		console.log(
			`Validated ${selected.length} cases. Add --live and --instructions to send provider turns.`,
		);
		return;
	}
	let instructions = await readFile(settings.instructions!, "utf8");
	if (!instructions.trim()) throw new Error("Instructions file is empty");
	// Bun may load a local .env. Set this before importing production agent singletons.
	process.env.HARNESS = "copilot-sdk";
	process.env.HARNESS_AUTH = "direct";
	process.env.SERVER_HOST = "127.0.0.1";
	let git = await gitState();
	let dir = join(settings.out, settings.runId);
	await mkdir(settings.out, { recursive: true });
	await mkdir(dir); // Never overwrite or mix runs.
	let manifest = {
		version: "planner-coach-run-v1",
		startedAt: new Date().toISOString(),
		label: settings.label,
		model: settings.model,
		instructionsHash: hash(instructions),
		scenarioHash,
		git,
		caseIds: selected.map(item => item.id),
		limits: {
			maxTools: settings.maxTools,
			turnTimeoutMs: settings.turnTimeoutMs,
			questionWaitMs: settings.questionWaitMs,
		},
		harness: "production copilot-sdk",
		provider: "GitHub Copilot",
		conversation:
			"Bounded prior human/Planner Chat text replayed per disposable turn (100 entries, 50000 characters)",
		visual: settings.visual,
		flags: Object.fromEntries(
			[
				"CONVERSATION_PLAN",
				"PLANNER_VISUALS",
				"LIVE_BUILD",
				"LIVE_SPIKES",
				"LIVE_SPIKES_REGEX_JUDGE",
			].map(flag => [flag, process.env[flag] === "on"]),
		),
		repository: {
			kind: "frozen synthetic fixture",
			files: Object.keys(repositoryFiles),
			liveGithubReads: false,
			toolOverrides: [
				"repository reads",
				"pull request reads",
				"bounded guards around real document tools",
				"external work refusal",
			],
		},
		status: "running",
		failures: [] as string[],
	};
	let clean = sanitizer();
	let save = async (path: string, value: unknown) => writeFile(path, clean(value));
	await save(join(dir, "manifest.json"), manifest);
	let transcripts: Transcript[] = [];
	let harnesses: typeof import("../../apps/server/src/harness/harnesses") | undefined;
	try {
		let token = await command(["gh", "auth", "token"]);
		if (!token) throw new Error("gh has no authenticated credential");
		clean = sanitizer([token]);
		await save(join(dir, "instructions.txt"), instructions);
		let originalError = console.error;
		console.error = (...values: unknown[]) => originalError(...values.map(value => clean(value)));
		try {
			harnesses = await import("../../apps/server/src/harness/harnesses");
			let { runScenario } = await import("./runner");
			let harness = harnesses.harnessFor({ harness: "copilot-sdk", harnessAuth: "direct" });
			for (let scenario of selected) {
				console.log(`Running ${scenario.id}`);
				let transcript = await runScenario(scenario, {
					harness,
					token,
					instructions,
					model: settings.model,
					visual: settings.visual,
					limits: settings,
				});
				transcripts.push(transcript);
				let caseDir = join(dir, "cases", scenario.id);
				await mkdir(caseDir, { recursive: true });
				await save(join(caseDir, "transcript.json"), transcript);
				await save(join(caseDir, "transcript.md"), markdown(transcript));
				await save(join(dir, "scorecard.json"), scorecard(transcripts));
			}
		} finally {
			console.error = originalError;
		}
	} catch (error) {
		manifest.failures.push(clean(error));
	} finally {
		try {
			await harnesses?.shutdownHarnesses();
		} catch (error) {
			manifest.failures.push(clean(error));
		}
		manifest.failures.push(...transcripts.flatMap(item => [
			...item.failures.map(failure => `${item.scenario.id}: ${failure}`),
			...item.turns.flatMap(turn =>
				turn.failures.map(failure => `${item.scenario.id}/${turn.number}: ${failure}`)
			),
		]));
		let awaitingHuman = transcripts.filter(item =>
			item.turns.some(turn => turn.status === "awaiting-human")
		);
		manifest.status = manifest.failures.length
			? "failed"
			: awaitingHuman.length
			? "awaiting-human"
			: "complete";
		await save(join(dir, "manifest.json"), {
			...manifest,
			endedAt: new Date().toISOString(),
			outcomes: {
				allTurnsComplete: transcripts.length === selected.length
					&& transcripts.every(item =>
						item.turns.length === item.scenario.turns.length
						&& item.turns.every(turn => turn.status === "complete")
					),
				awaitingHuman: awaitingHuman.map(item => item.scenario.id),
				undeliveredFollowups: transcripts.map(item => ({
					id: item.scenario.id,
					count: item.scenario.turns.length - item.turns.length,
				})),
			},
		});
	}
	console.log(`Artifacts: ${dir} (${manifest.status}; rubric remains unscored)`);
	if (manifest.failures.length) process.exitCode = 1;
}

if (import.meta.main) {
	main().catch(error => {
		console.error(sanitizer()(error));
		process.exitCode = 1;
	});
}
