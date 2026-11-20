import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MACHINE_STORE_ADAPTER } from "@chopin/protocol/machine-store";
import { machineStoreLogin, UNUSABLE_STORE_LOGIN } from "./machine";
import {
	AgentStore,
	forgetAgentStore,
	forgetMachineStore,
	provideMachineStore,
	savedMachineStore,
	saveMachineStore,
	storageSettings,
	storeAdapter,
	storeFolder,
	storeReport,
	UNUSABLE_SAVED_STORE,
} from "./machine-store";
import { ConnectorError } from "./mcp";
import { plannerEnvironment } from "./planner";

import type { AdapterInstaller } from "./machine-store";

const LOGIN = {
	url:
		"postgresql://m_0b5e6f0e7a7b4c1d9e1f2a3b4c5d6e7f@db.example.com:5432/m_0b5e6f0e7a7b4c1d9e1f2a3b4c5d6e7f?sslmode=verify-full",
	password: "fake-password-for-tests-only-0123456789",
};

let folders: string[] = [];
function folder() {
	let path = mkdtempSync(join(tmpdir(), "chopin-machine-store-"));
	folders.push(path);
	return path;
}
afterEach(() => {
	for (let path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function mode(path: string) {
	return statSync(path).mode & 0o777;
}

const fakeInstall: AdapterInstaller = async root => {
	let adapter = join(root, "node_modules", ...MACHINE_STORE_ADAPTER.split("/"));
	mkdirSync(adapter, { recursive: true });
	writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: MACHINE_STORE_ADAPTER }));
	writeFileSync(join(adapter, "postgres.js"), "export default {};\n");
	mkdirSync(join(root, "node_modules", "pg"), { recursive: true });
	writeFileSync(join(root, "node_modules", "pg", "package.json"), "{}");
};

function answering(login: typeof LOGIN | undefined) {
	return async () => login;
}

describe("a machine's database login on the connector", () => {
	test("saves the login readable only by its owner, the password apart from the URL", () => {
		let directory = folder();
		saveMachineStore(directory, LOGIN);
		let store = storeFolder(directory);
		if (process.platform !== "win32") {
			expect(mode(store)).toBe(0o700);
			expect(mode(join(store, "password"))).toBe(0o600);
			expect(mode(join(store, "settings.json"))).toBe(0o600);
		}
		expect(readFileSync(join(store, "password"), "utf8")).toBe(LOGIN.password);
		let settings = readFileSync(join(store, "settings.json"), "utf8");
		expect(settings).not.toContain(LOGIN.password);
		expect(JSON.parse(settings)).toEqual({
			storage: {
				adapter: MACHINE_STORE_ADAPTER,
				options: { url: LOGIN.url, maxConnections: 4 },
				secrets: { password: { file: join(store, "password") } },
			},
		});
		expect(savedMachineStore(directory)).toEqual(LOGIN);
		forgetMachineStore(directory);
		expect(savedMachineStore(directory)).toBeUndefined();
	});

	test("refuses settings whose URL holds a password, in words that never repeat it", () => {
		let secret = "postgresql://m_x:leaked-secret@db.example.com/m_x";
		expect(() => storageSettings(secret, "/tmp/password")).toThrow(UNUSABLE_SAVED_STORE);
		let directory = folder();
		mkdirSync(storeFolder(directory), { recursive: true });
		for (
			let url of [
				secret,
				"postgresql://m_x@db.example.com/m_x?password=leaked-secret",
				"https://db.example.com/m_x",
			]
		) {
			writeFileSync(
				join(storeFolder(directory), "settings.json"),
				JSON.stringify({ storage: { options: { url } } }),
			);
			writeFileSync(join(storeFolder(directory), "password"), "x");
			let error = (() => {
				try {
					savedMachineStore(directory);
				} catch (error) {
					return error as Error;
				}
			})();
			expect(error?.message).toBe(UNUSABLE_SAVED_STORE);
			expect(error?.message).not.toContain("leaked");
		}
	});

	test("installs the storage adapter once and reuses it", async () => {
		let directory = folder();
		let installs = 0;
		let install: AdapterInstaller = async root => {
			installs++;
			await fakeInstall(root);
		};
		let root = await storeAdapter(directory, install);
		expect(await storeAdapter(directory, install)).toBe(root);
		expect(installs).toBe(1);
		await expect(storeAdapter(folder(), async () => {})).rejects.toThrow("left no");
	});

	test("writes each agent's Atomic settings to read the database, keeping what was there", async () => {
		let directory = folder();
		let adapter = await storeAdapter(directory, fakeInstall);
		let store = new AgentStore(LOGIN, adapter);
		expect(store.host).toBe("db.example.com:5432");
		let atomic = join(folder(), "worktree.agent", "atomic");
		mkdirSync(atomic, { recursive: true });
		writeFileSync(
			join(atomic, "settings.json"),
			JSON.stringify({ theme: "dark", packages: ["npm:x"] }),
		);
		store.write(atomic);
		store.write(atomic);
		let settings = JSON.parse(readFileSync(join(atomic, "settings.json"), "utf8"));
		expect(settings).toEqual({
			theme: "dark",
			packages: ["npm:x", `npm:${MACHINE_STORE_ADAPTER}`],
			storage: {
				adapter: MACHINE_STORE_ADAPTER,
				options: { url: LOGIN.url, maxConnections: 4 },
				secrets: { password: { file: join(atomic, "storage-password") } },
			},
		});
		expect(readFileSync(join(atomic, "storage-password"), "utf8")).toBe(LOGIN.password);
		if (process.platform !== "win32") {
			expect(mode(join(atomic, "storage-password"))).toBe(0o600);
			expect(mode(join(atomic, "settings.json"))).toBe(0o600);
		}
		expect(
			existsSync(
				join(atomic, "npm", "node_modules", ...MACHINE_STORE_ADAPTER.split("/"), "postgres.js"),
			),
		).toBe(true);
		expect(readFileSync(join(atomic, "settings.json"), "utf8")).not.toContain(LOGIN.password);
	});

	test("gives a Planner on Chopin's AI accounts the same settings in its own agent state", async () => {
		let directory = folder();
		let store = new AgentStore(LOGIN, await storeAdapter(directory, fakeInstall));
		let worktree = join(folder(), "planner");
		let env = plannerEnvironment(true, worktree, {}, store);
		let atomic = env.ATOMIC_CODING_AGENT_DIR!;
		expect(atomic).toBe(join(`${worktree}.agent`, "atomic"));
		expect(JSON.parse(readFileSync(join(atomic, "settings.json"), "utf8")).storage.options.url)
			.toBe(LOGIN.url);
		expect(Object.values(env).join("\n")).not.toContain(LOGIN.password);
		let unmanaged = join(folder(), "own");
		plannerEnvironment(false, unmanaged, {}, store);
		expect(existsSync(`${unmanaged}.agent`)).toBe(false);
	});

	test("takes a Planner's generated database settings away once it has no store, keeping the rest", async () => {
		let store = new AgentStore(LOGIN, await storeAdapter(folder(), fakeInstall));
		let worktree = join(folder(), "planner");
		let atomic = plannerEnvironment(true, worktree, {}, store).ATOMIC_CODING_AGENT_DIR!;
		let path = join(atomic, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				...JSON.parse(readFileSync(path, "utf8")),
				theme: "dark",
				packages: ["npm:x", `npm:${MACHINE_STORE_ADAPTER}`],
			}),
		);
		expect(plannerEnvironment(true, worktree, {}).ATOMIC_CODING_AGENT_DIR).toBe(atomic);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", packages: ["npm:x"] });
		expect(existsSync(join(atomic, "storage-password"))).toBe(false);

		let ownStorage = {
			adapter: MACHINE_STORE_ADAPTER,
			options: { url: LOGIN.url },
			secrets: { password: { file: join(folder(), "elsewhere") } },
		};
		writeFileSync(path, JSON.stringify({ storage: ownStorage }));
		forgetAgentStore(atomic);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ storage: ownStorage });
	});

	test("sets the machine up from Chopin's answer when it pairs or connects", async () => {
		let directory = folder();
		let ready = await provideMachineStore({
			url: "https://chopin.example",
			token: "chopin_m_token",
			directory,
			install: fakeInstall,
			ask: answering(LOGIN),
		});
		expect(ready.state).toBe("ready");
		expect(storeReport(ready)).toEqual({
			failed: false,
			line:
				"Agents here keep their sessions in this machine's own database at db.example.com:5432.",
		});
		expect(savedMachineStore(directory)).toEqual(LOGIN);
		let off = await provideMachineStore({
			url: "https://chopin.example",
			token: "chopin_m_token",
			directory,
			install: fakeInstall,
			ask: answering(undefined),
		});
		expect(off).toEqual({ state: "off" });
		expect(storeReport(off)).toBeUndefined();
		expect(savedMachineStore(directory)).toBeUndefined();
	});

	test("says plainly why it couldn't, and never fails the pairing", async () => {
		let directory = folder();
		let refused = await provideMachineStore({
			url: "https://chopin.example",
			token: "chopin_m_token",
			directory,
			install: fakeInstall,
			ask: async () => {
				throw new ConnectorError(
					"machine-store-unavailable",
					"refused",
					503,
					"a machine could still connect to the database template1",
				);
			},
		});
		expect(refused).toEqual({
			state: "failed",
			reason: "a machine could still connect to the database template1",
		});
		expect(storeReport(refused)?.line).toBe(
			"Chopin couldn't set up this machine's database for agent sessions: a machine could still "
				+ "connect to the database template1. Pairing still worked. Agents here keep their "
				+ "sessions on this machine until a later connect sets it up.",
		);
		let unreachable = () =>
			provideMachineStore({
				url: "https://chopin.example",
				token: "chopin_m_token",
				directory,
				install: fakeInstall,
				ask: async () => {
					throw new TypeError("fetch failed");
				},
			});
		expect((await unreachable()).state).toBe("failed");
		saveMachineStore(directory, LOGIN);
		let saved = await unreachable();
		expect(saved.state).toBe("ready");
		expect(saved.state === "ready" && saved.saved).toBe(true);
		let noAdapter = await provideMachineStore({
			url: "https://chopin.example",
			token: "chopin_m_token",
			directory: folder(),
			install: async () => {
				throw new Error("npm install failed: E404");
			},
			ask: answering(LOGIN),
		});
		expect(noAdapter).toEqual({
			state: "failed",
			reason: "its storage adapter couldn't be set up: npm install failed: E404",
		});
	});

	test("asks Chopin with the machine token and refuses an answer with a password in its URL", async () => {
		let answers: Array<{ status: number; body: unknown }> = [];
		let seen: Array<{ path: string; authorization: string | null }> = [];
		let server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				seen.push({
					path: new URL(request.url).pathname,
					authorization: request.headers.get("authorization"),
				});
				let answer = answers.shift()!;
				return Response.json(answer.body, { status: answer.status });
			},
		});
		try {
			let url = `http://127.0.0.1:${server.port}`;
			answers.push({ status: 200, body: LOGIN });
			expect(await machineStoreLogin(url, "chopin_m_token")).toEqual(LOGIN);
			expect(seen).toEqual([{
				path: "/api/connector/machine-store",
				authorization: "Bearer chopin_m_token",
			}]);
			answers.push({ status: 404, body: { error: "not-found" } });
			expect(await machineStoreLogin(url, "chopin_m_token")).toBeUndefined();
			answers.push({
				status: 200,
				body: { url: "postgresql://m_x:leaked-secret@db.example.com/m_x", password: "p" },
			});
			let error = await machineStoreLogin(url, "chopin_m_token").then(
				() => undefined,
				(error: Error) => error,
			);
			expect(error?.message).toBe(UNUSABLE_STORE_LOGIN);
			expect(error?.message).not.toContain("leaked");
		} finally {
			server.stop(true);
		}
	});
});
