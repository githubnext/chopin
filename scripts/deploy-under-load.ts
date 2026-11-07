/**
 * The deploy-under-load test of docs/zero-downtime-deploys.md: many clients doing what people,
 * agents and machines do while Chopin is deployed over and over behind a proxy that holds
 * requests. It is run by hand or nightly, not as part of `bun test`: it takes minutes and needs a
 * database, a built client and, for the reference proxy or the built image, Docker.
 *
 *   bun scripts/deploy-under-load.ts --database <disposable cluster url> [options]
 *   bun scripts/deploy-under-load.ts --mode compose --image <built image> [options]
 *
 * It prints a summary and writes a JSON report, and exits 1 when a gate fails.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { SQL } from "bun";

import { BUDGET_MS, Probe } from "./overlap";
import { checkEdits, checkTurns, gates, summarize } from "./deploy-under-load/analysis";
import { RESTART_QUIET_MS } from "../packages/protocol/restart";
import { GRACE_MS } from "./deploy-under-load/client";
import { startEnvironment } from "./deploy-under-load/environment";
import { startBuild } from "./deploy-under-load/build";
import { handOver } from "./deploy-under-load/handover";
import { render } from "./deploy-under-load/report";

import {
	McpClient,
	promptsOf,
	readRows,
	readSources,
	Requests,
	seedDocuments,
	startEditors,
	startPlanners,
} from "./deploy-under-load/workload";

import type { Measures, Request } from "./deploy-under-load/analysis";
import type { Build } from "./deploy-under-load/build";
import type { Report } from "./deploy-under-load/report";
import type { Environment, EnvironmentOptions, Slot } from "./deploy-under-load/environment";
import type { HandOverRecord } from "./deploy-under-load/handover";
import type { Document, Planners } from "./deploy-under-load/workload";

export type Options = EnvironmentOptions & {
	documents: number;
	editors: number;
	handOvers: number;
	mcpClients: number;
	held: number;
	typeMs: number;
	/** The spread of a client's first attempt after a restart; undefined is a tab's own. */
	jitterMs?: number;
	requestMs: number;
	turnMs: number;
	warmMs: number;
	settleMs: number;
	betweenMs: number;
	maxGapMs: number;
	/** Whether the run leaves out the build that runs across the deploys. */
	skipBuild: boolean;
	report: string;
};

const USAGE = `usage:
  bun scripts/deploy-under-load.ts --database <disposable cluster url> [options]
  bun scripts/deploy-under-load.ts --mode compose --image <built image> [options]
options: --proxy <caddy|holding, caddy> --port <proxy port, 8810> --documents <3> --editors <6, at least
  the documents> --hand-overs <3> --mcp-clients <2> --held <documents with a turn running at each
  signal, 3> --type-ms <250> --request-ms <1500> --turn-ms <300> --turn-wait-ms <10000>
  --unready-ms <300> --planner-window-ms <10000> --warm-ms <1500> --settle-ms <2000>
  --between-ms <3000> --restart-jitter-ms <a tab's own, 1000> --max-gap-ms <${BUDGET_MS}> --report <.scratch/deploy-under-load.json>
  --skip-build --keep-database`;

export function parseArguments(argv: string[], env: Record<string, string | undefined>): Options {
	let { values } = parseArgs({
		args: argv,
		options: {
			mode: { type: "string", default: "processes" },
			proxy: { type: "string", default: "caddy" },
			database: { type: "string" },
			image: { type: "string" },
			port: { type: "string", default: "8810" },
			documents: { type: "string", default: "3" },
			editors: { type: "string" },
			"hand-overs": { type: "string", default: "3" },
			"mcp-clients": { type: "string", default: "2" },
			held: { type: "string", default: "3" },
			"type-ms": { type: "string", default: "250" },
			"restart-jitter-ms": { type: "string" },
			"request-ms": { type: "string", default: "1500" },
			"turn-ms": { type: "string", default: "300" },
			"turn-wait-ms": { type: "string", default: "10000" },
			"unready-ms": { type: "string", default: "300" },
			"planner-window-ms": { type: "string", default: "10000" },
			"warm-ms": { type: "string", default: "1500" },
			"settle-ms": { type: "string", default: "2000" },
			"between-ms": { type: "string", default: "3000" },
			"max-gap-ms": { type: "string", default: String(BUDGET_MS) },
			report: { type: "string", default: ".scratch/deploy-under-load.json" },
			"skip-build": { type: "boolean", default: false },
			"keep-database": { type: "boolean", default: false },
		},
	});
	let number = (name: string, value: string, least: number): number => {
		let parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < least) {
			throw new Error(`--${name} must be a whole number of at least ${least}\n${USAGE}`);
		}
		return parsed;
	};
	if (values.mode !== "processes" && values.mode !== "compose") throw new Error(USAGE);
	if (values.proxy !== "caddy" && values.proxy !== "holding") throw new Error(USAGE);
	let documents = number("documents", values.documents!, 1);
	let cluster = values.database ?? env.DATABASE_URL;
	if (values.mode === "processes" && !cluster) {
		throw new Error(`--database names a disposable cluster\n${USAGE}`);
	}
	let image = values.image ?? env.CHOPIN_IMAGE;
	if (values.mode === "compose" && !image) {
		throw new Error(`--image names the image to deploy\n${USAGE}`);
	}
	return {
		mode: values.mode,
		proxy: values.mode === "compose" ? "caddy" : values.proxy,
		cluster,
		image,
		port: number("port", values.port!, 1),
		documents,
		editors: number("editors", values.editors ?? String(documents * 2), documents),
		handOvers: number("hand-overs", values["hand-overs"]!, 1),
		mcpClients: number("mcp-clients", values["mcp-clients"]!, 1),
		held: Math.min(documents, number("held", values.held!, 0)),
		typeMs: number("type-ms", values["type-ms"]!, 10),
		jitterMs: values["restart-jitter-ms"] === undefined
			? undefined
			: number("restart-jitter-ms", values["restart-jitter-ms"], 0),
		requestMs: number("request-ms", values["request-ms"]!, 50),
		turnMs: number("turn-ms", values["turn-ms"]!, 0),
		turnWaitMs: number("turn-wait-ms", values["turn-wait-ms"]!, 1_000),
		unreadyMs: number("unready-ms", values["unready-ms"]!, 0),
		plannerWindowMs: number("planner-window-ms", values["planner-window-ms"]!, 1_000),
		warmMs: number("warm-ms", values["warm-ms"]!, 0),
		settleMs: number("settle-ms", values["settle-ms"]!, 0),
		betweenMs: number("between-ms", values["between-ms"]!, 0),
		maxGapMs: number("max-gap-ms", values["max-gap-ms"]!, 1),
		report: values.report!,
		skipBuild: values["skip-build"]!,
		keepDatabase: values["keep-database"]!,
	};
}

/** The most connections the database had open, and how late the driver's own timers ran. */
function sampling(env: Environment) {
	let state = { on: true };
	let peak = 0;
	let lags: number[] = [];
	let sql = new SQL(env.database);
	let polling = (async () => {
		while (state.on) {
			try {
				let [row] = await sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM pg_stat_activity
					WHERE datname = current_database() AND pid <> pg_backend_pid()
				`;
				peak = Math.max(peak, row?.count ?? 0);
			} catch { /* Read again. */ }
			await Bun.sleep(100);
		}
	})();
	let cpu: Array<{ at: number; slot: Slot; seconds: number }> = [];
	let measuring = setInterval(() => {
		for (let slot of ["a", "b"] as const) {
			let seconds = env.cpuSeconds?.(slot);
			if (seconds !== undefined) cpu.push({ at: performance.now(), slot, seconds });
		}
	}, 1_000);
	let last = performance.now();
	let lag = setInterval(() => {
		let now = performance.now();
		lags.push(Math.max(0, now - last - 20));
		last = now;
	}, 20);
	return {
		async stop() {
			state.on = false;
			clearInterval(lag);
			clearInterval(measuring);
			await polling;
			await sql.close();
			return { peakConnections: peak, driverLagMs: summarize(lags), cpu };
		},
	};
}

/** How many acknowledged requests of each kind were told they were queued behind something. */
function queuedBy(requests: Request[]): Record<string, number> {
	let counts: Record<string, number> = {};
	for (let request of requests) {
		if (request.acknowledged && request.queued) {
			counts[request.kind] = (counts[request.kind] ?? 0) + 1;
		}
	}
	return counts;
}

async function until(
	what: string,
	ready: () => boolean | Promise<boolean>,
	ms: number,
): Promise<boolean> {
	let deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (await ready()) return true;
		await Bun.sleep(50);
	}
	console.warn(`gave up waiting for ${what}`);
	return false;
}

export async function run(options: Options): Promise<{ report: Report; passed: boolean }> {
	let startedAt = new Date();
	let step = (what: string) =>
		console.log(`${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} s  ${what}`);
	let environment: Environment | undefined;
	let planners: Planners | undefined;
	let build: Build | undefined;
	let documents: Document[] = [];
	let mcpClients: McpClient[] = [];
	let reads: Array<{ stop(): Promise<void> }> = [];
	let steady: { stop(): Promise<void> } | undefined;
	let sample: ReturnType<typeof sampling> | undefined;
	try {
		environment = await startEnvironment(options);
		// Stopped from outside, the run still stops what it started: processes, containers and its database.
		for (let signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => void environment?.close().finally(() => process.exit(130)));
		}
		let env = environment;
		console.log(
			`deploying ${
				options.mode === "compose" ? options.image : "two processes on this host"
			} behind ${env.proxy}`,
		);
		step("environment is up");
		documents = await seedDocuments(env, options);
		step(`${documents.length} documents seeded`);
		sample = sampling(env);
		// Opening a document is what asks its owner's machine for a Planner, so the editors come first.
		await startEditors(documents);
		step(`${options.editors} editors open and typing`);
		planners = await startPlanners(env, documents, options.turnMs);
		step(`${planners.backends.length} Planners attached`);
		mcpClients = Array.from(
			{ length: options.mcpClients },
			() => new McpClient(env.origin, "mona"),
		);
		for (let client of mcpClients) await client.initialize();
		reads = mcpClients.map(client => client.read(documents.map(document => document.id), 200));
		if (!options.skipBuild) {
			build = await startBuild(env);
			step("a build is running on a connector");
		}
		let requests = new Requests(mcpClients[0]!);
		steady = requests.steady(documents, options.requestMs);
		let backends = new Map(planners.backends.map(backend => [backend.document, backend]));
		let records: HandOverRecord[] = [];
		let intervals: Array<{ from: number; to: number }> = [];
		let held: Document[] = [];

		for (let index = 1; index <= options.handOvers; index++) {
			let probe = new Probe(env.origin, { clients: 4, intervalMs: 15 });
			step(`hand-over ${index}: the idle slot starts`);
			held = Array.from(
				{ length: options.held },
				(_, offset) => documents[((index - 1) * options.held + offset) % documents.length]!,
			);
			let record = await handOver(env, index, probe, {
				warmMs: options.warmMs,
				settleMs: options.settleMs,
			}, {
				before: async () => {
					step(`hand-over ${index}: the idle slot waits; turns are started`);
					// A turn is running, and a request waits behind it, when the signal comes.
					for (let document of held) {
						let running = await requests.composer(document, "hold me");
						let backend = backends.get(document.id)!;
						let started = await until(
							`the turn of ${running.tag}`,
							() => backend.prompts.some(prompt => prompt.tag === running.tag),
							15_000,
						);
						if (!started) {
							let rows = (await readRows(env.database)).filter(row => row.document === document.id);
							throw new Error(
								`the turn of ${running.tag} on document ${document.index} did not start: `
									+ `acknowledged ${running.acknowledged}, refusal ${running.refusal}; `
									+ `${backend.prompts.length} prompts received, owner client synced ${document.owner.synced}; `
									+ `rows ${rows.map(row => `${row.kind} ${row.state}`).join(", ")}`,
							);
						}
						await requests.composer(document, "waits behind the turn");
					}
				},
				during: async () => {
					// The old process is still serving and takes every kind of request, starting none.
					await Promise.all(held.map(document => requests.everyKind(document)));
					for (let document of held) backends.get(document.id)!.release();
				},
			});
			records.push(record);
			let finished = performance.now();
			intervals.push({ from: record.moments.toldAt ?? record.moments.sigtermSentAt, to: finished });
			console.log(
				`#${index} slot ${record.from} to ${record.to}: first answer ${
					record.http.gapMs ?? "never"
				} ms after the release, `
					+ `${record.http.failures.length} of ${record.http.requests} requests not answered 2xx, old process exited ${record.exit}`,
			);
			if (index < options.handOvers) {
				await until(
					"every document and Planner to be back",
					() =>
						documents.every(document => document.editors.every(client => client.synced))
						&& planners!.backends.every(backend =>
							backend.resumes.length >= index || backend.errors.length > 0
						),
					20_000,
				);
				await Bun.sleep(options.betweenMs);
			}
		}

		let built = await build?.finish();
		if (built) step(`the build ended ${built.state}`);
		await steady.stop();
		steady = undefined;
		for (let read of reads) await read.stop();
		reads = [];
		await until(
			"every document and Planner to be back",
			() => documents.every(document => document.editors.every(client => client.synced)),
			20_000,
		);
		for (let document of documents) for (let client of document.editors) client.stopTyping();
		let drained = await Promise.all(
			documents.flatMap(document => document.editors.map(client => client.drain(30_000))),
		);
		await requests.settled();
		await until(
			"every saved request to be settled",
			async () =>
				(await readRows(env.database)).every(row =>
					row.state !== "waiting" && row.state !== "started"
				),
			30_000,
		);
		await Bun.sleep(1_000);

		for (let backend of planners.backends) {
			if (backend.errors.length) console.warn(backend.errors.join("\n"));
		}
		let finalSlot = await env.serving();
		let closed = finalSlot ? await env.stop(finalSlot) : null;
		let sources = await readSources(env.database, documents.map(document => document.id));
		let edits = documents.flatMap(document =>
			checkEdits(
				sources.get(document.id) ?? "",
				Object.fromEntries(document.editors.map(client => [client.marker, client.tokens])),
			)
		);
		let rows = await readRows(env.database);
		let turns = checkTurns(requests.all, rows, promptsOf(planners.backends));
		let stats = await sample.stop();
		sample = undefined;

		let clients = documents.flatMap(document => document.editors);
		let perHandOver = records.map((record, position) => {
			let { from, to } = intervals[position]!;
			let losses = clients.flatMap(client =>
				client.losses.filter(loss => loss.lostAt >= from - 200 && loss.lostAt < to - 200)
			);
			let gaps = losses.map(loss => (loss.reopenedAt ?? performance.now()) - loss.lostAt);
			let attempts = losses.flatMap(loss => loss.attempts);
			let resumes = planners!.backends.flatMap(backend =>
				backend.resumes.filter(resume =>
					resume.at >= (record.moments.releasedAt ?? from) && resume.at < to
				)
					.map(resume => resume.at - (record.moments.releasedAt ?? from))
			);
			let misses = records[position]!.plannerMissLines
				+ planners!.backends.filter(backend =>
					backend.closes.some(close => close.at >= from && close.at < to)
					&& !backend.resumes.some(resume => resume.at >= from && resume.at < to)
				).length;
			let abandoned = record.cut.abandoned.length;
			let busy = (slot: Slot, begin: number, end: number) => {
				let points = stats.cpu.filter(point =>
					point.slot === slot && point.at >= begin && point.at <= end
				);
				return summarize(
					points.slice(1).map((point, at) =>
						(point.seconds - points[at]!.seconds) / ((point.at - points[at]!.at) / 1_000) * 100
					),
				);
			};
			return {
				...record,
				ackBeforeMs: summarize(
					clients.flatMap(client =>
						client.acks.filter(ack => ack.at >= from - 10_000 && ack.at < from).map(ack => ack.ms)
					),
				),
				cpuPercent: stats.cpu.length === 0 ? undefined : {
					oldBefore: busy(record.from, from - 10_000, from),
					newAfter: busy(
						record.to,
						record.moments.readyAt ?? from,
						(record.moments.readyAt ?? from) + 5_000,
					),
				},
				clients: {
					losses: losses.length,
					announced: losses.filter(loss => loss.announced).length,
					gapMs: summarize(gaps),
					notices: losses.filter(loss => {
						let limit = loss.announced ? RESTART_QUIET_MS : GRACE_MS;
						return (loss.reopenedAt ?? performance.now()) - loss.lostAt > limit;
					}).length,
					pastGrace: gaps.filter(gap => gap > GRACE_MS).length,
					firstAttemptMs: summarize(
						losses.flatMap(loss => loss.attempts.slice(0, 1).map(attempt => attempt.offsetMs)),
					),
					upgradeMs: summarize(
						attempts.flatMap(attempt => attempt.upgradeMs === undefined ? [] : [attempt.upgradeMs]),
					),
					openMs: summarize(
						losses.flatMap(loss =>
							loss.reopenedAt !== undefined && loss.socketOpenedAt !== undefined
								? [loss.reopenedAt - loss.socketOpenedAt]
								: []
						),
					),
					upgradeAtRescueMs: summarize(
						attempts.filter(attempt => attempt.offsetMs >= 1_100 && attempt.upgradeMs !== undefined)
							.map(attempt => attempt.upgradeMs!),
					),
					attempts: attempts.length,
					failedAttempts: attempts.filter(attempt => !attempt.opened).length,
				},
				planners: { resumeMs: summarize(resumes), resumed: resumes.length, misses },
				resets: clients.reduce(
					(count, client) =>
						count
						+ client.resets.filter(reset => reset.at >= from - 200 && reset.at < to - 200).length,
					0,
				),
				abandoned,
			};
		});
		let measures: Measures = {
			budgetMs: BUDGET_MS,
			graceMs: GRACE_MS,
			quietMs: RESTART_QUIET_MS,
			maxGapMs: options.maxGapMs,
			handOvers: perHandOver.map(item => ({
				exit: item.exit,
				gapMs: item.http.gapMs,
				failed: item.http.failures,
				closedByCut: item.cut.abandoned,
				cutWindow: {
					from: item.moments.toldAt ?? item.moments.sigtermSentAt,
					to: item.moments.releasedAt ?? Infinity,
				},
				readinessRefused: item.cut.refused,
				noProxyCheck: item.cut.noProxyCheck,
				longestLossMs: item.clients.gapMs.max,
				notices: item.clients.notices,
				pastGrace: item.clients.pastGrace,
				resets: item.resets,
				plannerMisses: item.planners.misses,
			})),
			edits,
			turns,
			mcp: {
				calls: mcpClients.reduce((total, client) => total + client.calls, 0),
				failures: mcpClients.reduce((total, client) => total + client.failures.length, 0),
			},
			connector: { withdrawn: planners.connector.withdrawn.length },
			api: { calls: planners.calls.calls, failures: planners.calls.failures.length },
			...(built ? { build: built } : {}),
		};
		let list = gates(measures);
		if (!drained.every(Boolean)) {
			list.push({
				name: "every client's outbox drained",
				passed: false,
				detail: `${drained.filter(item => !item).length} did not`,
			});
		}
		if (closed !== 0) {
			list.push({
				name: "the last process stopped with exit 0",
				passed: false,
				detail: `exit ${closed}`,
			});
		}
		let passed = list.every(item => item.passed);
		let report: Report = {
			version: 1,
			startedAt: startedAt.toISOString(),
			durationMs: Date.now() - startedAt.getTime(),
			config: { ...options, cluster: undefined, image: options.image },
			environment: { mode: env.mode, proxy: env.proxy },
			workload: {
				documents: documents.length,
				editors: clients.length,
				wordsTyped: clients.reduce((total, client) => total + client.tokens.length, 0),
				updatesAcknowledged: clients.reduce((total, client) => total + client.acknowledged, 0),
				ackMs: summarize(clients.flatMap(client => client.ackMs)),
				outboxPeak: Math.max(0, ...clients.map(client => client.maxOutbox)),
				requests: turns.acknowledged,
				requestsQueued: queuedBy(requests.all),
				retriedRequests: requests.all.filter(request => request.retries > 0).length,
				mcp: {
					sessions: mcpClients.length,
					calls: measures.mcp.calls,
					failures: mcpClients.flatMap(client => client.failures).slice(0, 10),
				},
				api: { calls: planners.calls.calls, failures: planners.calls.failures.slice(0, 10) },
				connector: {
					reopened: planners.connector.reopened,
					withdrawn: planners.connector.withdrawn,
				},
				...(built ? { build: built } : {}),
			},
			handOvers: perHandOver.map(item => ({
				...item,
				http: { ...item.http, failures: item.http.failures.slice(0, 10) },
			})),
			edits: edits.filter(item => item.lost.length || item.duplicated.length || !item.ordered)
				.slice(0, 10),
			turns,
			database: { peakConnections: stats.peakConnections },
			driver: { loopLagMs: stats.driverLagMs },
			gates: list,
			passed,
		};
		return { report, passed };
	} finally {
		await steady?.stop();
		await build?.stop().catch(() => {});
		for (let read of reads) await read.stop().catch(() => {});
		for (let document of documents) for (let client of document.editors) client.stop();
		await planners?.stop().catch(() => {});
		await sample?.stop().catch(() => {});
		await environment?.close().catch(() => {});
	}
}

async function main(): Promise<number> {
	let options = parseArguments(process.argv.slice(2), process.env);
	let { report, passed } = await run(options);
	await mkdir(dirname(options.report), { recursive: true });
	await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
	console.log(render(report));
	console.log(`report: ${options.report}`);
	return passed ? 0 : 1;
}

if (import.meta.main) {
	main().then(code => process.exit(code), error => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		process.exit(1);
	});
}
