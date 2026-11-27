import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
	MACHINE_STORE_ADAPTER,
	type MachineStoreLogin,
	passwordlessStoreUrl,
} from "@chopin/protocol/machine-store";
import { failureCause, redacted } from "./connection";
import { classifyConnectorError, machineStoreLogin } from "./machine";
import { ConnectorError } from "./mcp";
import type { Output } from "./output";
import { readOwn, realDirectory, writeOwn } from "./ai-agent";

/** The adapter releases agents here are given, as the Atomic they run. */
export const STORE_ADAPTER_RANGE = "^0.10.11";
export const STORE_ADAPTER_SPEC = `${MACHINE_STORE_ADAPTER}@${STORE_ADAPTER_RANGE}`;
export const STORE_MAX_CONNECTIONS = 4;
export const UNUSABLE_SAVED_STORE =
	"The saved database settings for this machine's agents have no URL without a password, so they "
	+ "weren't used.";
const STORE_PACKAGE = `npm:${MACHINE_STORE_ADAPTER}`;
const INSTALL_TIMEOUT_MS = 180_000;

export function storeFolder(directory: string) {
	return join(directory, "agent-store");
}

function adapterManifest(root: string) {
	return join(root, "node_modules", ...MACHINE_STORE_ADAPTER.split("/"), "package.json");
}

/** Whether `root` holds an adapter release in `STORE_ADAPTER_RANGE`. */
function adapterInRange(root: string): boolean {
	let version: unknown;
	try {
		version = (JSON.parse(readFileSync(adapterManifest(root), "utf8")) as { version?: unknown })
			.version;
	} catch {
		return false;
	}
	return typeof version === "string" && Bun.semver.satisfies(version, STORE_ADAPTER_RANGE);
}

/** An agent's Atomic directory is shared writable with its microVM, so nothing a link names is written. */
function writePrivate(path: string, text: string) {
	writeOwn(path, text);
}

export function storageSettings(url: string, passwordFile: string) {
	if (!passwordlessStoreUrl(url)) throw new Error(UNUSABLE_SAVED_STORE);
	return {
		adapter: MACHINE_STORE_ADAPTER,
		options: { url, maxConnections: STORE_MAX_CONNECTIONS },
		secrets: { password: { file: passwordFile } },
	};
}

export function saveMachineStore(directory: string, login: MachineStoreLogin) {
	let folder = storeFolder(directory);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	let password = join(folder, "password");
	let settings = storageSettings(login.url, password);
	writePrivate(password, login.password);
	writePrivate(
		join(folder, "settings.json"),
		JSON.stringify({ storage: settings }, null, "\t") + "\n",
	);
}

export function savedMachineStore(directory: string): MachineStoreLogin | undefined {
	let folder = storeFolder(directory);
	let text: string;
	try {
		text = readFileSync(join(folder, "settings.json"), "utf8");
	} catch {
		return undefined;
	}
	let url: unknown;
	try {
		url = (JSON.parse(text) as { storage?: { options?: { url?: unknown } } }).storage?.options?.url;
	} catch {
		throw new Error(UNUSABLE_SAVED_STORE);
	}
	if (!passwordlessStoreUrl(url)) throw new Error(UNUSABLE_SAVED_STORE);
	let password = readFileSync(join(folder, "password"), "utf8");
	if (!password) throw new Error(UNUSABLE_SAVED_STORE);
	return { url, password };
}

export function forgetMachineStore(directory: string) {
	let folder = storeFolder(directory);
	rmSync(join(folder, "password"), { force: true });
	rmSync(join(folder, "settings.json"), { force: true });
}

export type AdapterInstaller = (root: string, signal?: AbortSignal) => Promise<void>;

export const npmInstall: AdapterInstaller = async (root, signal) => {
	let npm = Bun.which("npm");
	if (!npm) throw new Error("npm isn't on this machine's PATH");
	let child = Bun.spawn(
		[
			npm,
			"install",
			STORE_ADAPTER_SPEC,
			"--prefix",
			root,
			"--legacy-peer-deps",
			"--omit=dev",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		],
		{
			cwd: root,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			signal: AbortSignal.any([AbortSignal.timeout(INSTALL_TIMEOUT_MS), ...signal ? [signal] : []]),
		},
	);
	let [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) {
		let line = redacted(stderr).split("\n").map(value => value.trim()).findLast(Boolean);
		throw new Error(`npm install failed${line ? `: ${line.slice(0, 200)}` : ` (exit ${code})`}`);
	}
};

export async function storeAdapter(
	directory: string,
	install: AdapterInstaller = npmInstall,
	signal?: AbortSignal,
): Promise<string> {
	let root = join(storeFolder(directory), "npm");
	if (adapterInRange(root)) return root;
	// An install goes to a folder of its own and replaces the cached one only once it holds a
	// release in range, so a failed install never leaves an older or broken adapter to be served.
	let staging = `${root}.${process.pid}.${crypto.randomUUID()}`;
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(join(staging, "package.json"), '{"private": true}\n', { mode: 0o600 });
		await install(staging, signal);
		if (!adapterInRange(staging)) {
			throw new Error(`the install left no ${STORE_ADAPTER_SPEC}`);
		}
		rmSync(root, { recursive: true, force: true });
		renameSync(staging, root);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return root;
}

function agentSettings(path: string): Record<string, unknown> {
	try {
		// Never what a link a guest left there names: that could be any of the person's files.
		let parsed: unknown = JSON.parse(readOwn(path) ?? "");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function generatedStorage(storage: unknown, passwordFile: string) {
	let settings = storage as
		| { adapter?: unknown; secrets?: { password?: { file?: unknown } } }
		| undefined;
	return settings?.adapter === MACHINE_STORE_ADAPTER
		&& settings.secrets?.password?.file === passwordFile;
}

export function forgetAgentStore(atomicDirectory: string) {
	let password = join(atomicDirectory, "storage-password");
	let path = join(atomicDirectory, "settings.json");
	if (existsSync(path)) {
		let existing = agentSettings(path);
		if (generatedStorage(existing.storage, password)) {
			let { storage: _, packages, ...kept } = existing;
			let remaining = Array.isArray(packages)
				? packages.filter(value => value !== STORE_PACKAGE)
				: packages;
			writePrivate(
				path,
				JSON.stringify(
					{
						...kept,
						...(Array.isArray(remaining) && remaining.length === 0 ? {} : { packages: remaining }),
					},
					null,
					"\t",
				) + "\n",
			);
		}
	}
	rmSync(password, { force: true });
}

export class AgentStore {
	constructor(readonly login: MachineStoreLogin, readonly adapter: string) {}

	get host(): string {
		let url = new URL(this.login.url);
		return `${url.hostname}:${url.port || "5432"}`;
	}

	write(atomicDirectory: string) {
		realDirectory(atomicDirectory);
		// Made new, as a link a guest left in its place would send the copy elsewhere.
		rmSync(join(atomicDirectory, "npm"), { recursive: true, force: true });
		cpSync(this.adapter, join(atomicDirectory, "npm"), { recursive: true });
		let password = join(atomicDirectory, "storage-password");
		let storage = storageSettings(this.login.url, password);
		writePrivate(password, this.login.password);
		let path = join(atomicDirectory, "settings.json");
		let existing = agentSettings(path);
		let packages = Array.isArray(existing.packages) ? existing.packages : [];
		writePrivate(
			path,
			JSON.stringify(
				{
					...existing,
					packages: packages.includes(STORE_PACKAGE) ? packages : [...packages, STORE_PACKAGE],
					storage,
				},
				null,
				"\t",
			) + "\n",
		);
	}
}

export function keepSessionsIn(store: AgentStore, atomicDirectory: string, output?: Output) {
	try {
		store.write(atomicDirectory);
	} catch (error) {
		try {
			forgetAgentStore(atomicDirectory);
		} catch {}
		let code = (error as { code?: unknown }).code;
		output?.say(
			output.style.dim(
				`  This agent keeps its sessions on this machine: its database settings couldn't be `
					+ `written${typeof code === "string" ? ` (${code})` : ""}.`,
			),
		);
	}
}

export type MachineStoreOutcome =
	| { state: "off" }
	| { state: "ready"; store: AgentStore; saved?: true }
	| { state: "failed"; reason: string };

export async function provideMachineStore(options: {
	url: string;
	token: string;
	directory: string;
	signal?: AbortSignal;
	install?: AdapterInstaller;
	ask?: typeof machineStoreLogin;
}): Promise<MachineStoreOutcome> {
	let ask = options.ask ?? machineStoreLogin;
	let login: MachineStoreLogin | undefined;
	let saved = false;
	try {
		login = await ask(options.url, options.token, options.signal);
	} catch (error) {
		if (error instanceof ConnectorError && error.code === "machine-store-unavailable") {
			return { state: "failed", reason: error.said ?? "Chopin couldn't make it" };
		}
		if (classifyConnectorError(error) !== "retry") {
			return {
				state: "failed",
				reason: error instanceof Error ? redacted(error.message) : "Chopin refused",
			};
		}
		try {
			login = savedMachineStore(options.directory);
		} catch (savedError) {
			return { state: "failed", reason: (savedError as Error).message };
		}
		if (!login) {
			return { state: "failed", reason: `Chopin couldn't be asked (${failureCause(error)})` };
		}
		saved = true;
	}
	if (!login) {
		forgetMachineStore(options.directory);
		return { state: "off" };
	}
	try {
		if (!saved) saveMachineStore(options.directory, login);
		let adapter = await storeAdapter(options.directory, options.install, options.signal);
		return {
			state: "ready",
			store: new AgentStore(login, adapter),
			...saved ? { saved: true } : {},
		};
	} catch (error) {
		return {
			state: "failed",
			reason: `its storage adapter couldn't be set up: ${
				error instanceof Error ? redacted(error.message, [login.password]) : "unknown error"
			}`,
		};
	}
}

export function storeReport(
	outcome: MachineStoreOutcome,
): { line: string; failed: boolean } | undefined {
	if (outcome.state === "off") return undefined;
	if (outcome.state === "ready") {
		return {
			failed: false,
			line:
				`Agents here keep their sessions in this machine's own database at ${outcome.store.host}${
					outcome.saved ? ", with the login saved here, as Chopin couldn't be asked now" : ""
				}.`,
		};
	}
	return {
		failed: true,
		line: `Chopin couldn't set up this machine's database for agent sessions: ${outcome.reason}. `
			+ "Pairing still worked. Agents here keep their sessions on this machine until a later "
			+ "connect sets it up.",
	};
}
