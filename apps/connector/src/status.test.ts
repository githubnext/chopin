import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_UPDATE_REQUIRED } from "@chopin/protocol/connector";
import { SELF } from "./machine";
import type { ServiceHost } from "./service";
import { collectStatus, formatStatus } from "./status";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { processStart } from "./workspace";

let scratch = await mkdtemp(join(tmpdir(), "chopin-status-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const TOKEN = `chopin_m_${"S".repeat(43)}`;

/** A fake Chopin that answers the machine check with `answer`, recording the bearer it got. */
function chopin(answer: () => Response) {
	let bearers: string[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname !== "/api/connector/machine") {
				return new Response(null, { status: 404 });
			}
			bearers.push(request.headers.get("authorization") ?? "");
			return answer();
		},
	});
	return {
		bearers,
		url: `http://127.0.0.1:${server.port}`,
		[Symbol.dispose]: () => void server.stop(true),
	};
}

/** A state directory, paired with `url` unless it is undefined, and a Linux host without a unit. */
async function machine(url?: string) {
	let home = await mkdtemp(join(scratch, "home-"));
	let directory = join(home, "state");
	await mkdir(directory, { recursive: true });
	if (url) {
		await writeFile(
			join(directory, "machine.json"),
			JSON.stringify({ servers: { [url]: { token: TOKEN, label: "build-box" } } }),
		);
	}
	let host: ServiceHost = {
		platform: "linux",
		home,
		user: "ada",
		uid: 501,
		env: {},
		run: async () => {
			throw new Error("status ran a service manager command without a unit");
		},
	};
	return { directory, host };
}

test("status names the machine as Chopin does, after its owner renamed it there", async () => {
	using server = chopin(() => Response.json({ id: "m1", label: "Build box", login: "ada" }));
	let { directory, host } = await machine(server.url);
	let report = await collectStatus({ directory, server: server.url, source: "CHOPIN_URL", host });
	expect(report.machine).toEqual({
		paired: true,
		label: "Build box",
		check: "accepted",
		accepted: true,
		login: "ada",
	});
});

test("status reports a paired machine Chopin accepts, its connectors, a stale lock and the service", async () => {
	using server = chopin(() => Response.json({ id: "m1", label: "build-box", login: "ada" }));
	let { directory, host } = await machine(server.url);
	let started = Date.UTC(2026, 9, 13, 9, 30);
	await writeFile(
		join(directory, `${"a".repeat(64)}.lock`),
		JSON.stringify({
			pid: process.pid,
			processStart: (await processStart()(process.pid))!.id,
			root: "/work/score",
			version: "0.0.1",
			started,
			service: true,
			planners: ["https://chopin.example/d/one", "https://chopin.example/d/two"],
		}),
	);
	let gone = Bun.spawn(["true"]);
	await gone.exited;
	await writeFile(
		join(directory, `${"b".repeat(64)}.lock`),
		JSON.stringify({ pid: gone.pid, root: "/work/old" }),
	);
	// A connector whose pid another process holds now, one that started at another time.
	await writeFile(
		join(directory, `${"c".repeat(64)}.lock`),
		JSON.stringify({ pid: process.pid, processStart: "1", root: "/work/reused" }),
	);
	let report = await collectStatus({ directory, server: server.url, source: "CHOPIN_URL", host });
	expect(server.bearers).toEqual([`Bearer ${TOKEN}`]);
	expect(report).toEqual({
		version: VERSION,
		protocol: CONNECTOR_PROTOCOL,
		server: { origin: server.url, source: "CHOPIN_URL" },
		machine: { paired: true, label: "build-box", check: "accepted", accepted: true, login: "ada" },
		connectors: [
			{
				pid: process.pid,
				checkout: "/work/score",
				running: true,
				service: true,
				version: "0.0.1",
				started: "2026-10-13T09:30:00.000Z",
				planners: ["https://chopin.example/d/one", "https://chopin.example/d/two"],
			},
			{ pid: gone.pid, checkout: "/work/old", running: false, service: false },
			{ pid: process.pid, checkout: "/work/reused", running: false, service: false },
		],
		service: {
			state: "not-installed",
			manager: "systemd",
			definition: join(host.home, ".config", "systemd", "user", "chopin.service"),
			log: join(directory, "chopin.log"),
			notes: [],
		},
		log: join(directory, "chopin.log"),
		baseDir: directory,
		serviceRuns: null,
		lastConnect: null,
		runs: { kept: 0, running: 0, bytes: 0 },
		plannerWorktrees: [],
	});
	expect(JSON.stringify(report)).not.toContain(TOKEN);
	let text = formatStatus(report);
	expect(text).toEqual([
		`chopin ${VERSION} (connector protocol ${CONNECTOR_PROTOCOL})`,
		`Server:     ${server.url} (from CHOPIN_URL)`,
		"Machine:    paired as build-box (ada); Chopin accepts it",
		`Connector:  running for /work/score (pid ${process.pid}, chopin 0.0.1, the service)`,
		"              Planner for https://chopin.example/d/one",
		"              Planner for https://chopin.example/d/two",
		`            stale lock for /work/old: its connector (pid ${gone.pid}) has exited; the next `
		+ "connect replaces it",
		`            stale lock for /work/reused: its connector (pid ${process.pid}) has exited; `
		+ "the next connect replaces it",
		"Service:    not-installed (systemd)",
		`Log:        ${join(directory, "chopin.log")}`,
		`Base dir:   ${directory}`,
	]);
	expect(text.join("\n")).not.toContain(TOKEN);
});

test("status shows what the service runs, and the last connect when it differs", async () => {
	let { directory, host } = await machine();
	let runs = {
		server: "https://chopin.example",
		checkout: "/work/score",
		command: ["/usr/bin/agent", "--acp"],
		planners: [],
		plannerCommand: [],
	};
	let last = { ...runs, checkout: "/work/other" };
	await writeFile(
		join(directory, "config.json"),
		JSON.stringify({
			connect: last,
			service: {
				executable: "/opt/chopin",
				directory,
				version: VERSION,
				installedAt: 1,
				settings: runs,
			},
		}),
	);
	let report = await collectStatus({ directory, server: runs.server, source: "config", host });
	expect(report).toMatchObject({ serviceRuns: runs, lastConnect: last });
	let installed = {
		...report,
		service: {
			state: "running" as const,
			manager: "systemd" as const,
			definition: "/u",
			log: "/l",
			notes: [],
		},
	};
	expect(formatStatus(installed)).toContain(
		"            runs /work/score with /usr/bin/agent --acp, on https://chopin.example",
	);
	expect(formatStatus(installed)).toContain(
		"            chopin connect last ran /work/other with /usr/bin/agent --acp, on "
			+ "https://chopin.example; run chopin service install to use it",
	);
	let same = formatStatus({ ...installed, lastConnect: runs }).join("\n");
	expect(same).not.toContain("last ran");
});

test("status shows an agent that failed to start under its connector", async () => {
	let { directory, host } = await machine();
	let lock = `${"e".repeat(64)}`;
	await writeFile(
		join(directory, `${lock}.lock`),
		JSON.stringify({ pid: process.pid, root: "/work/score", service: true }),
	);
	let at = Date.UTC(2026, 9, 13, 9, 30);
	await writeFile(
		join(directory, `${lock}.failures.json`),
		JSON.stringify([{ kind: "agent", how: "exit 127", stderr: "agent: no credentials", at }]),
	);
	let report = await collectStatus({ directory, server: "https://x", source: "config", host });
	expect(report.connectors[0]?.failures).toEqual([
		{
			kind: "agent",
			how: "exit 127",
			stderr: "agent: no credentials",
			at: "2026-10-13T09:30:00.000Z",
		},
	]);
	expect(formatStatus(report)).toContain(
		"              Agent: failing (exit 127: agent: no credentials)",
	);
});

test("status says once a connector's machine uses its own GitHub login because the App can't push", async () => {
	let { directory, host } = await machine();
	let lock = "f".repeat(64);
	await writeFile(
		join(directory, `${lock}.lock`),
		JSON.stringify({
			pid: process.pid,
			processStart: (await processStart()(process.pid))!.id,
			root: "/work/score",
		}),
	);
	await writeFile(
		join(directory, `${lock}.github.json`),
		JSON.stringify({ repository: "octo-org/score" }),
	);
	let report = await collectStatus({ directory, server: "https://x", source: "config", host });
	expect(report.connectors[0]?.githubCannotPush).toBe("octo-org/score");
	expect(formatStatus(report)).toContain(
		"              The GitHub App can't push to octo-org/score (it needs Contents and Pull requests "
			+ "write), so this machine uses its own GitHub login for it.",
	);
});

test("status names a built-in agent by its --agent id, with the command it runs", async () => {
	let { directory, host } = await machine();
	let runs = {
		server: "https://chopin.example",
		checkout: "/work/score",
		agent: "atomic",
		command: ["/usr/bin/atomic-acp", "--", "--package", "/x"],
		planners: [],
		plannerCommand: [],
		env: { ATOMIC_ACP_HEADLESS: "1" },
	};
	await writeFile(
		join(directory, "config.json"),
		JSON.stringify({
			connect: runs,
			service: {
				executable: "/opt/chopin",
				directory,
				version: VERSION,
				installedAt: 1,
				settings: runs,
			},
		}),
	);
	let report = await collectStatus({ directory, server: runs.server, source: "config", host });
	let service = { state: "running" as const, manager: "systemd" as const, definition: "/u" };
	expect(formatStatus({ ...report, service: { ...service, log: "/l", notes: [] } })).toContain(
		"            runs /work/score with --agent atomic (/usr/bin/atomic-acp -- --package /x), on "
			+ "https://chopin.example",
	);
});

test("status lists the Planners' worktrees and the finished runs kept, with their size", async () => {
	let { directory, host } = await machine();
	let runs = join(directory, "runs");
	await mkdir(runs, { recursive: true });
	for (let id of ["a", "b"]) {
		await mkdir(join(runs, id));
		await writeFile(join(runs, id, "file.txt"), "x".repeat(64 * 1024));
		await writeFile(
			join(runs, `${id}.json`),
			JSON.stringify({ id, state: "finished", finished: 1 }),
		);
	}
	// A run this process has going, and one whose worktree retention already removed.
	await mkdir(join(runs, "going"));
	await writeFile(
		join(runs, "going.json"),
		JSON.stringify({
			id: "going",
			state: "accepted",
			pid: process.pid,
			processStart: (await processStart()(process.pid))!.id,
		}),
	);
	await writeFile(join(runs, "spike.json"), JSON.stringify({ id: "spike", state: "finished" }));
	let planner = join(directory, "planners", "octo-org", "score", "D_1");
	await mkdir(planner, { recursive: true });
	// The folder for a Planner that has yet to make its worktree.
	await mkdir(join(directory, "planners", "octo-org", "other"), { recursive: true });

	let report = await collectStatus({ directory, server: "https://x", source: "config", host });
	expect(report.plannerWorktrees).toEqual([
		{ path: planner, repository: "octo-org/score", document: "D_1" },
	]);
	expect(report.runs).toEqual({ kept: 2, running: 1, bytes: expect.any(Number) });
	expect(report.runs.bytes).toBeGreaterThanOrEqual(2 * 64 * 1024);
	let text = formatStatus(report);
	expect(text).toContainEqual(
		expect.stringMatching(/^Runs: {7}2 finished runs kept \(\d+(\.\d)? (kB|MB)\), 1 running$/),
	);
	expect(text).toContain(`Planners:   ${planner} (octo-org/score, document D_1)`);
});

test("status of an unpaired machine asks Chopin nothing", async () => {
	using server = chopin(() => Response.json({}));
	let { directory, host } = await machine();
	let report = await collectStatus({ directory, server: server.url, source: "default", host });
	expect(server.bearers).toEqual([]);
	expect(report.machine).toEqual({
		paired: false,
		label: null,
		check: "not-paired",
		accepted: null,
	});
	expect(report.connectors).toEqual([]);
	let text = formatStatus(report).join("\n");
	expect(text).toContain(`Machine:    not paired with ${server.url}; run \`${SELF} pair\``);
	expect(text).toContain("Connector:  not running");
});

test("status still reports when Chopin is down, and says when it refuses the machine", async () => {
	let closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	let url = `http://127.0.0.1:${closed.port}`;
	await closed.stop(true);
	let down = await machine(url);
	let report = await collectStatus({ ...down, server: url, source: "config" });
	expect(report.machine).toMatchObject({ paired: true, check: "unreachable", accepted: null });
	expect(report.service.state).toBe("not-installed");
	expect(formatStatus(report).join("\n")).toContain(
		"Machine:    paired as build-box; can't reach Chopin to check it (",
	);

	using revoked = chopin(() =>
		Response.json({ error: "machine-revoked", message: "machine-revoked" }, { status: 401 })
	);
	let paired = await machine(revoked.url);
	let refused = await collectStatus({ ...paired, server: revoked.url, source: "config" });
	expect(refused.machine).toMatchObject({ check: "revoked", accepted: false });
	expect(formatStatus(refused).join("\n")).toContain(
		"Machine:    paired as build-box; Chopin no longer accepts it (machine-revoked). "
			+ `Run \`${SELF} pair\`.`,
	);

	using outdated = chopin(() =>
		Response.json({ error: CONNECTOR_UPDATE_REQUIRED, message: "Run `chopin update 0.2.0`." }, {
			status: 409,
		})
	);
	let old = await machine(outdated.url);
	expect((await collectStatus({ ...old, server: outdated.url, source: "config" })).machine)
		.toMatchObject({
			check: "update-required",
			accepted: false,
			detail: "Run `chopin update 0.2.0`.",
		});

	// A server that never answers is given up on after the timeout.
	let hung = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise(() => {}) });
	let slow = await machine(`http://127.0.0.1:${hung.port}`);
	let timed = await collectStatus({
		...slow,
		server: `http://127.0.0.1:${hung.port}`,
		source: "config",
		timeoutMs: 100,
	});
	expect(timed.machine).toMatchObject({ check: "unreachable" });
	await hung.stop(true);
});

// Run under a temporary HOME, so the service check sees no unit and runs nothing.
test.skipIf(process.platform === "win32")(
	"chopin status --json reads the base dir it is given and prints the report",
	async () => {
		using server = chopin(() => Response.json({ id: "m1", label: "build-box", login: "ada" }));
		let { directory, host } = await machine(server.url);
		let child = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"status",
			"--json",
			"--base-dir",
			directory,
		], {
			env: { PATH: process.env.PATH, HOME: host.home, CHOPIN_URL: server.url },
			stdout: "pipe",
			stderr: "pipe",
		});
		let [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		let report = JSON.parse(stdout);
		expect(report).toMatchObject({
			server: { origin: server.url, source: "CHOPIN_URL" },
			machine: { paired: true, label: "build-box", check: "accepted" },
			service: { state: "not-installed" },
			baseDir: directory,
		});
		expect(stdout).not.toContain(TOKEN);
	},
);

test.skipIf(process.platform === "win32")(
	"with CHOPIN_URL unset, chopin status checks and shows the server chopin connect saved",
	async () => {
		using server = chopin(() => Response.json({ id: "m1", label: "build-box", login: "ada" }));
		let { directory, host } = await machine(server.url);
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({
				connect: { server: server.url, checkout: host.home, command: ["agent"], planners: [] },
			}),
		);
		let child = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"status",
			"--base-dir",
			directory,
		], { env: { PATH: process.env.PATH, HOME: host.home }, stdout: "pipe", stderr: "pipe" });
		let [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(stdout).toContain(`Server:     ${server.url} (saved by chopin connect)\n`);
		expect(stdout).toContain("Machine:    paired as build-box (ada); Chopin accepts it\n");
	},
);
