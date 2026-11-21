import { afterAll, expect, test } from "bun:test";
import { hostSandbox } from "./testing/host-sandbox";
import type { Launch } from "./sandbox";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { answerTokens, BOT } from "./testing/github-grant";
import { checkouts, clonePath } from "./checkouts";
import { createOutput } from "./output";
import { servePlanners } from "./planner";
import { type LaunchGate, launchGate } from "./launch-gate";
import { type Memory, plannerSpares, READY_LINE, SPARE_BYTES } from "./planner-spare";
import { git, plannerDisks, plannerSlot, type SpareState } from "./workspace";

/**
 * Spare Planners: one Planner command started ahead per registered checkout's repository, handed a
 * new document's Planner over its stdin (spare protocol 1, see `planner-spare.ts`), and the cold
 * launch of today whenever a spare can't be used.
 */

let scratch = await mkdtemp(join(tmpdir(), "chopin-spare-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const MACHINE = `chopin_m_${"M".repeat(43)}`;
const CREDENTIAL = `chopin_p_${"P".repeat(43)}`;
const SPARE = join(import.meta.dir, "testing", "spare-planner.ts");
const REPOSITORY = "octo-org/score";

async function checkout(at?: string) {
	let root = at ?? await mkdtemp(join(scratch, "checkout-"));
	await mkdir(root, { recursive: true });
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
	return root;
}

async function entries(log: string): Promise<Array<Record<string, any>>> {
	let text = await readFile(log, "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function until(condition: () => Promise<boolean> | boolean, withinMs: number) {
	for (let deadline = Date.now() + withinMs; Date.now() < deadline; await Bun.sleep(25)) {
		if (await condition()) return;
	}
	throw new Error("timed out");
}

/**
 * A fake Chopin: a Planner credential for whichever document is asked for, the launch tokens as a
 * Chopin with its GitHub App answers them, `github` answering the GitHub token instead where given,
 * and the Chopin token held `mcpMs` first.
 */
function chopin(options: { github?: (asked: number) => Response; mcpMs?: number } = {}) {
	let asked = 0;
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let path = new URL(request.url).pathname;
			if (path === "/api/connector/github-token" && options.github) return options.github(asked++);
			if (path === "/api/connector/mcp-token" && options.mcpMs) await Bun.sleep(options.mcpMs);
			let answered = await answerTokens(request);
			if (answered) return answered;
			if (path === "/api/connector/planner") {
				let { document } = await request.json() as { document: string };
				return Response.json({
					token: CREDENTIAL,
					expiresAt: Date.now() + 15 * 60_000,
					// A document named `<name>_<n>` is in `octo-org/<name>`, any other in octo-org/score.
					document: {
						id: document,
						repository: /^[a-z]+_\d+$/.test(document)
							? `octo-org/${document.split("_")[0]}`
							: REPOSITORY,
					},
				});
			}
			return Response.json({});
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Everything one test runs: a checkout, a base dir, the spares, and what they said. With `clone`,
 * no checkout is registered: the repository is the clone the machine made of it in its base dir, as
 * a machine without --checkout has, and finding it does what a fetch leaves.
 */
async function machine(options: {
	url: string;
	mode?: string;
	command?: string[];
	readyMs?: number;
	replaceMs?: number;
	off?: boolean;
	clone?: boolean;
	directory?: string;
	/** Chopin's answer to whether the machine can push to a repository, as asked. */
	check?: (repository: string) => Promise<string>;
	checkMs?: number;
	memory?: Memory;
	cap?: number;
	gate?: LaunchGate;
	burstMs?: number;
	quietMs?: number;
	/** Waited on as a clone is fetched for work in `repository`. */
	fetching?: (repository: string) => Promise<void>;
	/** How long each launch's stand-in microVM takes to boot, and who hears it boot. */
	bootMs?: number;
	heard?: (event: "boot" | "booted", launch: Launch) => void;
}) {
	let directory = options.directory ?? await mkdtemp(join(scratch, "base-"));
	let root = options.clone
		? clonePath(directory, REPOSITORY)
		: await checkout();
	if (options.clone && !existsSync(join(root, ".git"))) await checkout(root);
	let registered: Record<string, string> = options.clone ? {} : { [REPOSITORY]: root };
	let log = join(directory, "backend.jsonl");
	// Its own guests' `/work`, as each microVM has its own.
	let sandbox = hostSandbox({}, {
		...(options.bootMs ? { bootMs: options.bootMs } : {}),
		...(options.heard ? { heard: options.heard } : {}),
	});
	let said = "";
	let capture = {
		write: (chunk: string | Uint8Array) => {
			said += String(chunk);
			return true;
		},
	};
	let output = createOutput(capture, capture, {});
	let states: SpareState[] = [];
	let env = {
		CHOPIN_TEST_SPARE_LOG: log,
		SOME_FLAG: "flag-value",
		...(options.mode ? { CHOPIN_TEST_SPARE: options.mode } : {}),
	};
	let command = options.command ?? [process.execPath, SPARE];
	let abort = new AbortController();
	let start = (signal = abort.signal) =>
		plannerSpares({
			sandbox,
			url: options.url,
			command,
			registered,
			directory,
			output,
			signal,
			env,
			states: {
				record(next) {
					states = next;
					return Promise.resolve();
				},
			},
			...(options.readyMs === undefined ? {} : { readyMs: options.readyMs }),
			replaceMs: options.replaceMs ?? 60_000,
			...(options.off ? { off: true } : {}),
			...(options.check ? { check: options.check } : {}),
			...(options.checkMs === undefined ? {} : { checkMs: options.checkMs }),
			...(options.memory ? { memory: options.memory } : {}),
			...(options.cap === undefined ? {} : { cap: options.cap }),
			...(options.gate ? { gate: options.gate } : {}),
			...(options.burstMs === undefined ? {} : { burstMs: options.burstMs }),
			...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
		});
	let serve = (documents: string[], spares: ReturnType<typeof start>, signal = abort.signal) =>
		servePlanners({
			sandbox,
			url: options.url,
			machine: MACHINE,
			documents,
			command,
			checkouts: options.clone
				? {
					registered,
					resolve: async (repository: string) => {
						await options.fetching?.(repository);
						return { root: await realpath(clonePath(directory, repository)), env: {} };
					},
				}
				: checkouts({ directory, registered }),
			directory,
			output,
			signal,
			env,
			spares,
			...(options.gate ? { gate: options.gate } : {}),
		});
	return {
		root,
		directory,
		sandbox,
		log,
		abort,
		start,
		serve,
		said: () => said,
		state: (repository = REPOSITORY) =>
			states.find(state => state.repository.toLowerCase() === repository.toLowerCase())?.state,
		states: () => states,
		events: () => entries(log),
	};
}

test.skipIf(process.platform === "win32")(
	"a spare starts ahead with no document and no credential, takes a new document's Planner at once over its stdin, and a replacement follows",
	async () => {
		let server = chopin();
		let it = await machine({ url: server.url, replaceMs: 300 });
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			let [started] = await it.events();
			// Nothing of a document, no credential: only where its files will be.
			let slot = dirname(started!.env.CHOPIN_PLANNER_TOKEN_FILE as string).slice(
				0,
				-".tokens".length,
			);
			expect(slot).toMatch(/[/\\]planners[/\\]octo-org[/\\]score[/\\]spare-[0-9a-f]{12}$/);
			expect(started).toMatchObject({
				event: "start",
				spare: true,
				env: {
					CHOPIN_URL: server.url,
					CHOPIN_DOCUMENT: null,
					CHOPIN_PLANNER_TOKEN: null,
					CHOPIN_GITHUB_TOKEN: null,
					GIT_AUTHOR_NAME: null,
					CHOPIN_PLANNER_SPARE: "1",
					CHOPIN_CHECKOUT: it.root,
					CHOPIN_WORKTREE: join(it.sandbox.work, "score"),
					CHOPIN_PLANNER_TOKEN_FILE: join(`${slot}.tokens`, "planner"),
					CHOPIN_MCP_TOKEN_FILE: join(`${slot}.tokens`, "mcp"),
					CHOPIN_GITHUB_TOKEN_FILE: join(`${slot}.tokens`, "github"),
					GH_CONFIG_DIR: join(`${slot}.tokens`, "gh"),
					SOME_FLAG: "flag-value",
				},
			});
			// Its repository is a clone of its own, at the checkout's HEAD, on its disk; the person's
			// repository has nothing added.
			expect(existsSync(`${slot}.disk`)).toBe(true);
			expect(git(join(it.sandbox.work, "score"), "rev-parse", "HEAD")).toBe(
				git(it.root, "rev-parse", "HEAD"),
			);
			expect(git(it.root, "worktree", "list")).not.toContain(slot);
			// Its ready line is the connector's, never passed on.
			expect(it.said()).not.toContain(READY_LINE);

			let serving = it.serve(["D_1"], spares);
			await until(async () => (await it.events()).some(entry => entry.event === "github"), 20_000);
			let events = await it.events();
			let assign = events.find(entry => entry.event === "assign")!;
			let github = events.find(entry => entry.event === "github")!;
			// The credentials were in their files before it was told the document; no line holds one.
			expect(assign.planner).toBe(CREDENTIAL);
			expect(assign.mcp).toBe(`chopin_mcp_${"T".repeat(43)}`);
			expect(JSON.parse(assign.line)).toEqual({
				type: "assign",
				protocol: 1,
				document: "D_1",
				documentId: "D_1",
				env: { CHOPIN_DOCUMENT: "D_1" },
				github: "pending",
			});
			expect(github.github).toBe(`ghs_${"G".repeat(36)}`);
			expect(JSON.parse(github.line)).toMatchObject({
				type: "github",
				env: { GIT_AUTHOR_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email },
			});
			for (let line of [assign.line, github.line]) {
				expect(line).not.toContain("chopin_p_");
				expect(line).not.toContain("chopin_mcp_");
				expect(line).not.toContain("ghs_");
			}
			// The spare is the document's backend: nothing started cold.
			expect(events.filter(entry => entry.event === "start")).toHaveLength(1);
			expect(it.said()).toContain("› Planner for D_1 started.");
			// Its slot, and the disk its repository is on, are the document's for good.
			expect(await plannerSlot(it.directory, REPOSITORY, "D_1")).toBe(slot);
			expect(await plannerDisks(it.directory)).toEqual([
				{ path: `${slot}.disk`, repository: REPOSITORY, document: "D_1", server: server.url },
			]);

			// The replacement starts a moment later, in a slot of its own.
			await until(
				async () => (await it.events()).filter(entry => entry.event === "start").length === 2,
				20_000,
			);
			await until(() => it.state() === "ready", 20_000);
			let replacement = (await it.events()).filter(entry => entry.event === "start")[1]!;
			let second = dirname(replacement.env.CHOPIN_PLANNER_TOKEN_FILE as string)
				.slice(0, -".tokens".length);
			expect(second).not.toBe(slot);

			// Stopping ends the document's backend and the spare; only the spare's slot goes.
			it.abort.abort();
			await serving;
			await spares.stop();
			let ended = await it.events();
			expect(ended.filter(entry => entry.event === "end" || entry.event === "sigterm"))
				.toHaveLength(2);
			expect(existsSync(`${slot}.disk`)).toBe(true);
			expect(existsSync(`${second}.disk`)).toBe(false);
			expect(existsSync(`${second}.tokens`)).toBe(false);
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a command that never prints the ready line, or exits first, is recorded as not taking spare mode and documents start cold",
	async () => {
		let server = chopin();
		for (let mode of ["silent", "old"]) {
			let it = await machine({ url: server.url, mode, readyMs: 800 });
			let spares = it.start();
			try {
				await until(() => it.state() === "unsupported", 20_000);
				let record = JSON.parse(await readFile(join(it.directory, "planner-spare.json"), "utf8"));
				expect(Object.keys(record.unsupported)).toEqual([
					JSON.stringify([process.execPath, SPARE]),
				]);
				expect(it.said()).toContain("didn't start as a spare");
				// It was stopped, and its slot removed.
				await until(
					async () =>
						!(await readdir(join(it.directory, "planners", "octo-org", "score")))
							.some(name => /^spare-[0-9a-f]{12}/.test(name)),
					10_000,
				);

				// The next connector doesn't offer it again, and a document starts as before.
				await spares.stop();
				let again = new AbortController();
				let next = it.start(again.signal);
				await until(() => it.state() === "unsupported", 10_000);
				let before = (await it.events()).length;
				let serving = it.serve(["D_1"], next, again.signal);
				await until(
					async () => (await it.events()).some(entry => entry.env?.CHOPIN_DOCUMENT),
					20_000,
				);
				let cold = (await it.events()).slice(before);
				expect(cold).toHaveLength(1);
				expect(cold[0]).toMatchObject({
					event: "start",
					spare: false,
					env: {
						CHOPIN_DOCUMENT: "D_1",
						CHOPIN_PLANNER_TOKEN: CREDENTIAL,
						CHOPIN_PLANNER_SPARE: null,
					},
				});
				again.abort();
				await serving;
				await next.stop();
			} finally {
				it.abort.abort();
				await spares.stop();
			}
		}
		await server.stop();
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a spare that exits once ready is replaced and still offered spare mode; one whose command changed is never handed a document",
	async () => {
		let server = chopin();
		let script = join(scratch, `spare-${crypto.randomUUID()}.ts`);
		await copyFile(SPARE, script);
		let it = await machine({ url: server.url, mode: "crash", command: [process.execPath, script] });
		let spares = it.start();
		try {
			// It crashed after printing ready: replaced on the backoff, never recorded unsupported.
			await until(
				async () => (await it.events()).filter(entry => entry.event === "start").length >= 2,
				20_000,
			);
			expect(existsSync(join(it.directory, "planner-spare.json"))).toBe(false);
			expect(it.state()).not.toBe("unsupported");
		} finally {
			it.abort.abort();
			await spares.stop();
		}

		let fresh = await machine({ url: server.url, command: [process.execPath, script] });
		let pool = fresh.start();
		try {
			await until(() => fresh.state() === "ready", 20_000);
			// The command is upgraded in place: the spare it made is stopped, and the document starts
			// cold on the new one.
			await writeFile(script, `${await readFile(script, "utf8")}\n// upgraded\n`);
			let serving = fresh.serve(["D_1"], pool);
			await until(
				async () => (await fresh.events()).some(entry => entry.env?.CHOPIN_DOCUMENT),
				20_000,
			);
			let events = await fresh.events();
			expect(events.some(entry => entry.event === "assign")).toBe(false);
			expect(events.find(entry => entry.env?.CHOPIN_DOCUMENT)).toMatchObject({ spare: false });
			expect(events.some(entry => entry.event === "end" || entry.event === "sigterm")).toBe(true);
			fresh.abort.abort();
			await serving;
		} finally {
			fresh.abort.abort();
			await pool.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"Chopin refusing the GitHub token after the hand-over stops the backend with the refusal, and Chopin out of reach is tried again while it runs",
	async () => {
		let refusing = chopin({
			github: () => Response.json({ error: "app-cannot-push" }, { status: 403 }),
		});
		let it = await machine({ url: refusing.url });
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			await it.serve(["D_1"], spares);
			let events = await it.events();
			let stop = events.find(entry => entry.event === "stop")!;
			expect(JSON.parse(stop.line).reason).toContain(REPOSITORY);
			expect(events.some(entry => entry.event === "github")).toBe(false);
			expect(it.said()).toContain("Stopped the Planner for D_1:");
		} finally {
			it.abort.abort();
			await spares.stop();
			await refusing.stop();
		}

		let flaky = chopin({
			github: asked =>
				asked < 2
					? Response.json({ error: "unavailable" }, { status: 503 })
					: Response.json({
						token: `ghs_${"G".repeat(36)}`,
						expiresAt: Date.now() + 3_600_000,
						identity: BOT,
					}),
		});
		let again = await machine({ url: flaky.url });
		let pool = again.start();
		try {
			await until(() => again.state() === "ready", 20_000);
			let serving = again.serve(["D_1"], pool);
			await until(
				async () => (await again.events()).some(entry => entry.event === "github"),
				20_000,
			);
			let events = await again.events();
			// Told the document first, the GitHub token followed once Chopin gave it.
			expect(events.map(entry => entry.event)).toEqual(["start", "assign", "github"]);
			expect(again.said()).toContain("its Planner runs without one meanwhile");
			again.abort.abort();
			await serving;
		} finally {
			again.abort.abort();
			await pool.stop();
			await flaky.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a spare that dies before its hand-over is let go and the document starts cold; a second document at once, and one with a disk here, start cold",
	async () => {
		// The Chopin token takes long enough for the spare to crash first.
		let slow = chopin({ mcpMs: 1_500 });
		let it = await machine({ url: slow.url, mode: "crash" });
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			let serving = it.serve(["D_1"], spares);
			await until(
				async () => (await it.events()).some(entry => entry.env?.CHOPIN_DOCUMENT),
				20_000,
			);
			let events = await it.events();
			expect(events.some(entry => entry.event === "assign")).toBe(false);
			expect(it.said()).toContain("Couldn't hand D_1 to the spare Planner");
			it.abort.abort();
			await serving;
		} finally {
			it.abort.abort();
			await spares.stop();
			await slow.stop();
		}

		let server = chopin();
		let two = await machine({ url: server.url });
		let pool = two.start();
		try {
			// D_3 has a disk here already: it never takes a spare.
			let made = await plannerSlot(two.directory, REPOSITORY, "D_3");
			await writeFile(`${made}.disk`, "");
			await until(() => two.state() === "ready", 20_000);
			let serving = two.serve(["D_3"], pool);
			await until(
				async () => (await two.events()).some(entry => entry.env?.CHOPIN_DOCUMENT === "D_3"),
				20_000,
			);
			expect((await two.events()).some(entry => entry.event === "assign")).toBe(false);
			let both = two.serve(["D_1", "D_2"], pool);
			await until(
				async () => {
					let events = await two.events();
					return events.some(entry => entry.event === "assign")
						&& events.filter(entry => entry.env?.CHOPIN_DOCUMENT).length === 2;
				},
				20_000,
			);
			let events = await two.events();
			let assigned = JSON.parse(events.find(entry => entry.event === "assign")!.line).document;
			let cold = events.filter(entry => entry.env?.CHOPIN_DOCUMENT).map(entry =>
				entry.env.CHOPIN_DOCUMENT
			);
			expect(cold.sort()).toEqual(["D_3", assigned === "D_1" ? "D_2" : "D_1"].sort());
			two.abort.abort();
			await Promise.all([serving, both]);
		} finally {
			two.abort.abort();
			await pool.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a slot a connector left that never got a document goes as the next one starts, and with --no-planner-spare none starts",
	async () => {
		let server = chopin();
		let it = await machine({ url: server.url });
		let left = join(it.directory, "planners", "octo-org", "score", "spare-aaaaaaaaaaaa");
		await mkdir(join(it.directory, "planners", "octo-org", "score"), { recursive: true });
		await writeFile(`${left}.disk`, "a spare's disk");
		await mkdir(`${left}.tokens`);
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			expect(existsSync(`${left}.disk`)).toBe(false);
			expect(existsSync(`${left}.tokens`)).toBe(false);
		} finally {
			it.abort.abort();
			await spares.stop();
		}

		let off = await machine({ url: server.url, off: true });
		let none = off.start();
		await Bun.sleep(800);
		expect(off.state()).toBe("off");
		expect(await off.events()).toEqual([]);
		off.abort.abort();
		await none.stop();
		await server.stop();
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a repository the machine cloned keeps a spare once a Planner ran in it: the next new document starts on it, and so does the next connector",
	async () => {
		let server = chopin();
		let it = await machine({ url: server.url, clone: true, replaceMs: 300 });
		let spares = it.start();
		let clone = await realpath(it.root);
		try {
			// No Planner ran in it yet, so nothing is kept for it.
			await Bun.sleep(500);
			expect(await it.events()).toEqual([]);

			// D_1 starts cold; its repository is served from then on, and its spare follows.
			let first = it.serve(["D_1"], spares);
			await until(() => it.state() === "ready", 20_000);
			let started = (await it.events()).filter(entry => entry.event === "start");
			expect(started.map(entry => entry.spare)).toEqual([false, true]);
			// The spare holds nothing of D_1, or of any document: no credential, an empty token folder.
			let spare = started[1]!;
			expect(spare.env).toMatchObject({
				CHOPIN_CHECKOUT: clone,
				CHOPIN_DOCUMENT: null,
				CHOPIN_PLANNER_TOKEN: null,
				CHOPIN_GITHUB_TOKEN: null,
			});
			let slot = dirname(spare.env.CHOPIN_PLANNER_TOKEN_FILE as string).slice(0, -".tokens".length);
			expect(await readdir(`${slot}.tokens`)).toEqual([]);
			expect(slot).not.toBe(await plannerSlot(it.directory, REPOSITORY, "D_1"));

			// D_2, a new document, is handed that spare at once.
			let second = it.serve(["D_2"], spares);
			await until(async () => (await it.events()).some(entry => entry.event === "assign"), 20_000);
			let assign = (await it.events()).find(entry => entry.event === "assign")!;
			expect(JSON.parse(assign.line).document).toBe("D_2");
			expect(assign.pid).toBe(spare.pid);
			expect(await plannerSlot(it.directory, REPOSITORY, "D_2")).toBe(slot);

			// Its replacement is a spare of its own, in a slot of its own.
			await until(
				async () =>
					(await it.events()).filter(entry => entry.event === "start" && entry.spare).length === 2,
				20_000,
			);
			await until(() => it.state() === "ready", 20_000);
			it.abort.abort();
			await Promise.all([first, second]);
			await spares.stop();

			// The next connector, before any document: the repository it served gets its spare again.
			let again = new AbortController();
			let before = (await it.events()).length;
			let next = it.start(again.signal);
			await until(() => it.state() === "ready", 20_000);
			let restarted = (await it.events()).slice(before).filter(entry => entry.event === "start");
			expect(restarted).toHaveLength(1);
			expect(restarted[0]).toMatchObject({ spare: true, env: { CHOPIN_CHECKOUT: clone } });
			again.abort();
			await next.stop();
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a repository Chopin says this machine can't push to keeps no spare: none starts, and one kept goes once Chopin refuses, then comes back when it can push again",
	async () => {
		let server = chopin();
		let answer = "starter-cannot-push";
		let asked: string[] = [];
		let it = await machine({
			url: server.url,
			checkMs: 300,
			check: async repository => {
				asked.push(repository);
				return answer;
			},
		});
		let spares = it.start();
		try {
			// Refused before it starts: nothing starts, and status lists no spare for it.
			await until(() => asked.length >= 1, 10_000);
			await Bun.sleep(500);
			expect(await it.events()).toEqual([]);
			expect(it.state()).toBeUndefined();

			// Asked again a moment later, it can push there now: its spare starts.
			answer = "ok";
			await until(() => it.state() === "ready", 20_000);
			let [started] = await it.events();
			let slot = dirname(started!.env.CHOPIN_PLANNER_TOKEN_FILE as string).slice(
				0,
				-".tokens".length,
			);

			// The owner loses push access: the next check lets the spare go, slot and all.
			answer = "app-cannot-push";
			await until(
				async () => (await it.events()).some(entry => entry.event === "end"),
				10_000,
			);
			await until(() => !existsSync(`${slot}.disk`) && !existsSync(`${slot}.tokens`), 10_000);
			expect(it.state()).toBeUndefined();
			// And no new one starts while Chopin refuses.
			await Bun.sleep(800);
			expect((await it.events()).filter(entry => entry.event === "start")).toHaveLength(1);
		} finally {
			it.abort.abort();
			await spares.stop();
		}

		// A Planner's own GitHub token refused: the repository's spare goes at once, and no
		// replacement follows the document it was handed.
		let refusing = chopin({
			github: () => Response.json({ error: "starter-cannot-push" }, { status: 403 }),
		});
		let other = await machine({ url: refusing.url, replaceMs: 200, checkMs: 60_000 });
		let pool = other.start();
		try {
			await until(() => other.state() === "ready", 20_000);
			await other.serve(["D_1"], pool);
			await Bun.sleep(1_000);
			expect((await other.events()).filter(entry => entry.event === "start")).toHaveLength(1);
			expect(other.state()).toBeUndefined();
		} finally {
			other.abort.abort();
			await pool.stop();
			await refusing.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"spares are kept for the repositories served most recently, as many as the cap and the machine's memory allow, and none start while memory is short",
	async () => {
		let server = chopin();
		// A tenth of the machine's memory holds two spares.
		let it = await machine({
			url: server.url,
			clone: true,
			replaceMs: 50,
			memory: () => ({ total: 20 * SPARE_BYTES, available: 64 * SPARE_BYTES }),
		});
		for (let name of ["octo-org/alpha", "octo-org/beta"]) {
			await checkout(clonePath(it.directory, name));
		}
		let spares = it.start();
		let started = async () =>
			(await it.events()).filter(entry => entry.event === "start").map(entry =>
				basename(entry.env.CHOPIN_CHECKOUT as string)
			);
		try {
			spares.served("octo-org/alpha");
			await Bun.sleep(5);
			spares.served("octo-org/beta");
			await Bun.sleep(5);
			spares.served(REPOSITORY);
			await until(() => it.state() === "ready" && it.state("octo-org/beta") === "ready", 20_000);
			expect(it.states().map(state => state.repository).sort()).toEqual([
				"octo-org/beta",
				REPOSITORY,
			]);
			expect((await started()).sort()).toEqual(["beta", "score"]);
			// Each repository's spare is its own: one with none is handed nothing.
			expect(await spares.take("octo-org/alpha")).toBeUndefined();

			// alpha is served again: it and score are the two most recent, and beta's spare goes.
			spares.served("octo-org/alpha");
			await until(() => it.state("octo-org/alpha") === "ready", 20_000);
			await until(
				async () => (await it.events()).filter(entry => entry.event === "end").length === 1,
				10_000,
			);
			expect(it.state("octo-org/beta")).toBeUndefined();
			expect((await started()).sort()).toEqual(["alpha", "beta", "score"]);
		} finally {
			it.abort.abort();
			await spares.stop();
		}

		// A cap of one: only the most recent repository's.
		let capped = await machine({ url: server.url, clone: true, replaceMs: 50, cap: 1 });
		await checkout(clonePath(capped.directory, "octo-org/alpha"));
		let one = capped.start();
		try {
			one.served(REPOSITORY);
			await Bun.sleep(5);
			one.served("octo-org/alpha");
			await until(() => capped.state("octo-org/alpha") === "ready", 20_000);
			await Bun.sleep(300);
			expect(capped.states().map(state => state.repository)).toEqual(["octo-org/alpha"]);
			expect((await capped.events()).filter(entry => entry.event === "start")).toHaveLength(1);
		} finally {
			capped.abort.abort();
			await one.stop();
		}

		// Too little memory available beside one: none starts, and status says it waits for memory.
		let short = await machine({
			url: server.url,
			memory: () => ({ total: 64 * SPARE_BYTES, available: 2 * SPARE_BYTES }),
		});
		let none = short.start();
		try {
			await until(() => short.state() === "memory", 10_000);
			await Bun.sleep(300);
			expect(await short.events()).toEqual([]);
		} finally {
			short.abort.abort();
			await none.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a spare that served a document is never handed another: the next document gets the replacement, and the first starts again cold in its own slot",
	async () => {
		let server = chopin();
		let it = await machine({ url: server.url, replaceMs: 100 });
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			let one = new AbortController();
			let first = it.serve(["D_1"], spares, AbortSignal.any([it.abort.signal, one.signal]));
			await until(async () => (await it.events()).some(entry => entry.event === "assign"), 20_000);
			let handed = (await it.events()).find(entry => entry.event === "assign")!;
			// D_1's Planner stops; its spare's process ends with it.
			one.abort();
			await first;
			await until(() => it.state() === "ready", 20_000);

			let second = it.serve(["D_2"], spares);
			await until(
				async () => (await it.events()).filter(entry => entry.event === "assign").length === 2,
				20_000,
			);
			let next = (await it.events()).filter(entry => entry.event === "assign")[1]!;
			expect(JSON.parse(next.line).document).toBe("D_2");
			expect(next.pid).not.toBe(handed.pid);
			let slot = await plannerSlot(it.directory, REPOSITORY, "D_1");
			expect(await plannerSlot(it.directory, REPOSITORY, "D_2")).not.toBe(slot);

			// D_1 again: cold, in the slot its spare left it, which no other document has.
			let again = it.serve(["D_1"], spares);
			await until(
				async () => (await it.events()).some(entry => entry.env?.CHOPIN_DOCUMENT === "D_1"),
				20_000,
			);
			let cold = (await it.events()).find(entry => entry.env?.CHOPIN_DOCUMENT === "D_1")!;
			expect(cold.spare).toBe(false);
			expect(dirname(cold.env.CHOPIN_PLANNER_TOKEN_FILE as string)).toBe(`${slot}.tokens`);
			it.abort.abort();
			await Promise.all([second, again]);
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

/** The documents that got a Planner, by the events of the backends: a spare's hand-over, or a cold start. */
function plannersOf(events: Array<Record<string, any>>) {
	return [
		...events.filter(entry => entry.event === "assign").map(entry =>
			JSON.parse(entry.line).document as string
		),
		...events.filter(entry => entry.event === "start" && entry.env?.CHOPIN_DOCUMENT).map(entry =>
			entry.env.CHOPIN_DOCUMENT as string
		),
	];
}

/** The most spares that waited for a document at one moment: from each one's start to its hand-over or end. */
function sparesAtOnce(events: Array<Record<string, any>>) {
	let moments: Array<[number, number]> = [];
	for (let start of events.filter(entry => entry.event === "start" && entry.spare)) {
		let over = events.find(entry =>
			entry.pid === start.pid && ["assign", "end", "sigterm"].includes(entry.event)
		);
		moments.push([start.at, 1], [over?.at ?? Number.MAX_SAFE_INTEGER, -1]);
	}
	let most = 0;
	let now = 0;
	for (let [, change] of moments.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
		now += change;
		most = Math.max(most, now);
	}
	return most;
}

for (let count of [2, 5, 10]) {
	test.skipIf(process.platform === "win32")(
		`${count} new documents of one repository at once each get one Planner: the spare goes to one, the rest boot cold as many at once as the gate allows, and none is handed a spare twice`,
		async () => {
			let server = chopin();
			let gate = launchGate(3);
			let booting = 0;
			let peak = 0;
			let cold = 0;
			let coldPeak = 0;
			let it = await machine({
				url: server.url,
				clone: true,
				replaceMs: 100,
				bootMs: 150,
				gate,
				// A tenth of the machine's memory holds two spares, however many a burst wants.
				memory: () => ({ total: 20 * SPARE_BYTES, available: 64 * SPARE_BYTES }),
				heard: (event, launch) => {
					let change = event === "boot" ? 1 : -1;
					booting += change;
					peak = Math.max(peak, booting);
					if (launch.env.CHOPIN_PLANNER_SPARE) return;
					cold += change;
					coldPeak = Math.max(coldPeak, cold);
				},
			});
			let spares = it.start();
			try {
				spares.served(REPOSITORY);
				await until(() => it.state() === "ready", 20_000);
				peak = booting;
				let documents = Array.from({ length: count }, (_, index) => `D_${index + 1}`);
				let serving = it.serve(documents, spares);
				await until(async () => plannersOf(await it.events()).length >= count, 30_000);
				let events = await it.events();
				// Every document has one Planner, and only one.
				expect(plannersOf(events).sort()).toEqual([...documents].sort());
				// One went to the spare that was ready, and no spare was handed twice.
				let handed = events.filter(entry => entry.event === "assign");
				expect(handed.length).toBeGreaterThanOrEqual(1);
				expect(new Set(handed.map(entry => entry.pid)).size).toBe(handed.length);
				// The rest booted cold, as many at once as the gate's three allow, and never more microVMs
				// than that booted at once, spares' included.
				expect(coldPeak).toBe(Math.min(3, count - 1));
				expect(peak).toBeLessThanOrEqual(3);
				expect(gate.counts().documents).toBe(0);
				// Its spares, a burst's refill among them, stayed within the memory's two.
				await until(() => (it.states()[0]?.count ?? 0) === 2 || count < 3, 20_000);
				expect(sparesAtOnce(await it.events())).toBeLessThanOrEqual(2);
				it.abort.abort();
				await serving;
			} finally {
				it.abort.abort();
				await spares.stop();
				await server.stop();
			}
		},
		60_000,
	);
}

test.skipIf(process.platform === "win32")(
	"a burst that uses a repository's spare refills more than one, within the bound, so the rest of the fan-out starts warm, and one again once it is quiet",
	async () => {
		let server = chopin();
		let it = await machine({
			url: server.url,
			clone: true,
			replaceMs: 1_000,
			quietMs: 3_000,
			gate: launchGate(3),
			// A tenth of the machine's memory holds four spares.
			memory: () => ({ total: 40 * SPARE_BYTES, available: 64 * SPARE_BYTES }),
		});
		let spares = it.start();
		try {
			spares.served(REPOSITORY);
			await until(() => it.state() === "ready", 20_000);
			// Two at once: one takes the spare, the other finds none ready, which is a burst.
			let first = it.serve(["D_1", "D_2"], spares);
			await until(async () => plannersOf(await it.events()).length === 2, 20_000);
			// The repository keeps four ready now, not one.
			await until(() => it.states()[0]?.count === 4, 20_000);
			let before = await it.events();
			// The fan-out goes on: three more at once, all on spares.
			let second = it.serve(["D_3", "D_4", "D_5"], spares);
			await until(async () => plannersOf(await it.events()).length === 5, 20_000);
			let after = (await it.events()).slice(before.length);
			expect(
				after.filter(entry => entry.event === "assign").map(entry =>
					JSON.parse(entry.line).document
				).sort(),
			).toEqual(["D_3", "D_4", "D_5"]);
			expect(after.some(entry => entry.event === "start" && !entry.spare)).toBe(false);
			// It refills while the burst lasts.
			await until(() => it.states()[0]?.count === 4, 20_000);
			// Quiet for a while, the repository goes back to one spare and lets the others go.
			let waiting = async () => {
				let events = await it.events();
				return events.filter(entry => entry.event === "start" && entry.spare).filter(start =>
					!events.some(entry =>
						entry.pid === start.pid && ["assign", "end", "sigterm"].includes(entry.event)
					)
				).length;
			};
			await Bun.sleep(3_000);
			await until(async () => await waiting() === 1, 20_000);
			expect(it.state()).toBe("ready");
			expect(it.states()[0]?.count).toBeUndefined();
			it.abort.abort();
			await Promise.all([first, second]);
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"new documents of three repositories at once each get one Planner, each repository's spare going to one of its own",
	async () => {
		let server = chopin();
		let gate = launchGate(3);
		let booting = 0;
		let peak = 0;
		let it = await machine({
			url: server.url,
			clone: true,
			replaceMs: 300,
			gate,
			bootMs: 100,
			memory: () => ({ total: 40 * SPARE_BYTES, available: 64 * SPARE_BYTES }),
			heard: event => {
				booting += event === "boot" ? 1 : -1;
				peak = Math.max(peak, booting);
			},
		});
		for (let name of ["alpha", "beta"]) await checkout(clonePath(it.directory, `octo-org/${name}`));
		let spares = it.start();
		try {
			for (let repository of ["octo-org/alpha", "octo-org/beta", REPOSITORY]) {
				spares.served(repository);
			}
			await until(
				() => it.states().length === 3 && it.states().every(state => state.state === "ready"),
				20_000,
			);
			let documents = ["alpha_1", "alpha_2", "beta_1", "beta_2", "score_1", "score_2"];
			let serving = it.serve(documents, spares);
			await until(async () => plannersOf(await it.events()).length >= 6, 30_000);
			let events = await it.events();
			expect(plannersOf(events).sort()).toEqual([...documents].sort());
			let handed = events.filter(entry => entry.event === "assign");
			expect(new Set(handed.map(entry => entry.pid)).size).toBe(handed.length);
			// Each repository's spare went to one of its own documents.
			expect(handed).toHaveLength(3);
			for (let assign of handed) {
				let started = events.find(entry => entry.event === "start" && entry.pid === assign.pid)!;
				expect(JSON.parse(assign.line).document.split("_")[0]).toBe(
					basename(started.env.CHOPIN_CHECKOUT as string),
				);
			}
			expect(peak).toBeLessThanOrEqual(3);
			// No document waits for a slot; spares refilling the burst may.
			expect(gate.counts().documents).toBe(0);
			it.abort.abort();
			await serving;
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"Chopin's word that the machine can push, asked before it refused, never brings a refused repository's spare back",
	async () => {
		let server = chopin();
		// A Planner's GitHub token asked for before the refusal, its launch heard after it.
		let it = await machine({ url: server.url, clone: true, replaceMs: 100 });
		let spares = it.start();
		try {
			let asked = Date.now();
			await Bun.sleep(5);
			spares.refused(REPOSITORY);
			spares.served(REPOSITORY, asked);
			await Bun.sleep(800);
			expect(await it.events()).toEqual([]);
			expect(it.state()).toBeUndefined();
		} finally {
			it.abort.abort();
			await spares.stop();
		}

		// The pool's own check, asked before the refusal and answered after it.
		let answered!: () => void;
		let held = new Promise<void>(resolve => answered = resolve);
		let calls = 0;
		let again = await machine({
			url: server.url,
			checkMs: 400,
			check: async () => {
				calls++;
				if (calls === 1) return "ok";
				if (calls === 2) {
					await held;
					return "ok";
				}
				return "starter-cannot-push";
			},
		});
		let pool = again.start();
		try {
			await until(() => again.state() === "ready", 20_000);
			await until(() => calls === 2, 10_000);
			pool.refused(REPOSITORY);
			answered();
			await Bun.sleep(1_200);
			expect((await again.events()).filter(entry => entry.event === "start")).toHaveLength(1);
			expect(again.state()).toBeUndefined();
		} finally {
			again.abort.abort();
			await pool.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a document whose clone is still being fetched holds no slot of the gate: another repository's document boots meanwhile",
	async () => {
		let server = chopin();
		let fetched!: () => void;
		let held = new Promise<void>(resolve => fetched = resolve);
		let it = await machine({
			url: server.url,
			clone: true,
			gate: launchGate(1),
			fetching: async repository => {
				if (repository === "octo-org/alpha") await held;
			},
		});
		await checkout(clonePath(it.directory, "octo-org/alpha"));
		let spares = it.start();
		let cold = async (document: string) =>
			(await it.events()).some(entry => entry.env?.CHOPIN_DOCUMENT === document);
		try {
			let alpha = it.serve(["alpha_1"], spares);
			await Bun.sleep(300);
			let score = it.serve(["score_1"], spares);
			// The only slot isn't alpha's while GitHub is fetched for it.
			await until(() => cold("score_1"), 10_000);
			expect(await cold("alpha_1")).toBe(false);
			fetched();
			await until(() => cold("alpha_1"), 10_000);
			it.abort.abort();
			await Promise.all([alpha, score]);
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);

test.skipIf(process.platform === "win32")(
	"a spare gives its slot back once its microVM has booted: with a gate of one, another repository's new document boots while the spare waits to be taken",
	async () => {
		let server = chopin();
		let gate = launchGate(1);
		let it = await machine({ url: server.url, clone: true, gate, bootMs: 100, replaceMs: 100 });
		await checkout(clonePath(it.directory, "octo-org/alpha"));
		let spares = it.start();
		try {
			spares.served(REPOSITORY);
			await until(() => it.state() === "ready", 20_000);
			expect(gate.counts().held).toBe(0);
			let alpha = it.serve(["alpha_1"], spares);
			await until(
				async () => (await it.events()).some(entry => entry.env?.CHOPIN_DOCUMENT === "alpha_1"),
				10_000,
			);
			// score's spare is still there for score's next document.
			expect(it.state()).toBe("ready");
			expect((await it.events()).some(entry => entry.event === "assign")).toBe(false);
			it.abort.abort();
			await alpha;
		} finally {
			it.abort.abort();
			await spares.stop();
			await server.stop();
		}
	},
	60_000,
);
