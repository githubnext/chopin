import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerTokens, BOT } from "./testing/github-grant";
import { checkouts } from "./checkouts";
import { createOutput } from "./output";
import { servePlanners } from "./planner";
import { plannerSpares, READY_LINE } from "./planner-spare";
import {
	git,
	plannerWorktree,
	plannerWorktrees,
	preparePlannerWorktree,
	type SpareState,
} from "./workspace";

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

async function checkout() {
	let root = await mkdtemp(join(scratch, "checkout-"));
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
					document: { id: document, repository: REPOSITORY },
				});
			}
			return Response.json({});
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Everything one test runs: a checkout, a base dir, the spares, and what they said. */
async function machine(options: {
	url: string;
	mode?: string;
	command?: string[];
	readyMs?: number;
	replaceMs?: number;
	off?: boolean;
}) {
	let root = await checkout();
	let directory = await mkdtemp(join(scratch, "base-"));
	let log = join(directory, "backend.jsonl");
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
			url: options.url,
			command,
			registered: { [REPOSITORY]: root },
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
		});
	let serve = (documents: string[], spares: ReturnType<typeof start>, signal = abort.signal) =>
		servePlanners({
			url: options.url,
			machine: MACHINE,
			documents,
			command,
			checkouts: checkouts({ directory, registered: { [REPOSITORY]: root } }),
			directory,
			output,
			signal,
			env,
			spares,
		});
	return {
		root,
		directory,
		log,
		abort,
		start,
		serve,
		said: () => said,
		state: () => states[0]?.state,
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
			let slot = started!.env.CHOPIN_WORKTREE as string;
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
					CHOPIN_PLANNER_TOKEN_FILE: join(`${slot}.tokens`, "planner"),
					CHOPIN_MCP_TOKEN_FILE: join(`${slot}.tokens`, "mcp"),
					CHOPIN_GITHUB_TOKEN_FILE: join(`${slot}.tokens`, "github"),
					GH_CONFIG_DIR: join(`${slot}.tokens`, "gh"),
					SOME_FLAG: "flag-value",
				},
			});
			// Its worktree is a linked worktree of the checkout, made on the host, at its HEAD.
			expect(git(slot, "rev-parse", "HEAD")).toBe(git(it.root, "rev-parse", "HEAD"));
			expect(git(it.root, "worktree", "list")).toContain(slot);
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
			// Its slot is the document's worktree for good.
			expect(await plannerWorktree(it.directory, REPOSITORY, "D_1")).toBe(slot);
			expect(await plannerWorktrees(it.directory)).toEqual([
				{ path: slot, repository: REPOSITORY, document: "D_1" },
			]);

			// The replacement starts a moment later, in a slot of its own.
			await until(
				async () => (await it.events()).filter(entry => entry.event === "start").length === 2,
				20_000,
			);
			await until(() => it.state() === "ready", 20_000);
			let replacement = (await it.events()).filter(entry => entry.event === "start")[1]!;
			let second = replacement.env.CHOPIN_WORKTREE as string;
			expect(second).not.toBe(slot);

			// Stopping ends the document's backend and the spare; only the spare's slot goes.
			it.abort.abort();
			await serving;
			await spares.stop();
			let ended = await it.events();
			expect(ended.filter(entry => entry.event === "end" || entry.event === "sigterm"))
				.toHaveLength(2);
			expect(existsSync(slot)).toBe(true);
			expect(existsSync(second)).toBe(false);
			expect(existsSync(`${second}.tokens`)).toBe(false);
			expect(git(it.root, "worktree", "list")).not.toContain(second);
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
					async () => !/spare-[0-9a-f]{12}/.test(git(it.root, "worktree", "list")),
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
	"a spare that dies before its hand-over is let go and the document starts cold; a second document at once, and one with a worktree here, start cold",
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
			// D_3 has a worktree here already: it never takes a spare.
			let made = await plannerWorktree(two.directory, REPOSITORY, "D_3");
			await mkdir(made, { recursive: true });
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
		expect(await preparePlannerWorktree(it.root, left)).toBe(true);
		await mkdir(`${left}.tokens`);
		let spares = it.start();
		try {
			await until(() => it.state() === "ready", 20_000);
			expect(existsSync(left)).toBe(false);
			expect(existsSync(`${left}.tokens`)).toBe(false);
			expect(git(it.root, "worktree", "list")).not.toContain(left);
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
