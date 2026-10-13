import { spawn } from "node:child_process";
import { classifyConnectorError, connectorMessage, plannerCredential } from "./machine";
import { backoff, delay, HEALTHY_MS, transient } from "./reconnect";
import type { Output } from "./output";

/** How long a stopped Planner backend has to exit before it is killed. */
const STOP_GRACE_MS = 5000;

/**
 * Split a `--planner-command` line into its words: whitespace separates them, and single or double
 * quotes keep spaces inside one.
 */
export function commandWords(line: string): string[] {
	let words: string[] = [];
	for (let match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		words.push(match[1] ?? match[2] ?? match[3]!);
	}
	return words;
}

/**
 * Run `command` as each document's Planner backend until `signal` aborts. Every launch gets a fresh
 * Planner credential, passed only in its environment as CHOPIN_URL, CHOPIN_DOCUMENT and
 * CHOPIN_PLANNER_TOKEN. A backend that exits, as one whose link closed or whose credential was
 * refused does, is started again on the reconnect backoff. A revoked machine or a document Chopin
 * refuses stops that document's backend.
 */
export async function servePlanners(options: {
	url: string;
	machine: string;
	documents: string[];
	command: string[];
	cwd: string;
	output: Output;
	signal: AbortSignal;
}) {
	await Promise.all(options.documents.map(document => servePlanner({ ...options, document })));
}

async function servePlanner(options: {
	url: string;
	machine: string;
	document: string;
	command: string[];
	cwd: string;
	output: Output;
	signal: AbortSignal;
}) {
	let { output, signal, document } = options;
	for (let attempt = 0; !signal.aborted;) {
		let started = Date.now();
		let credential;
		try {
			credential = await plannerCredential(options.url, options.machine, document, signal);
		} catch (error) {
			if (signal.aborted) return;
			if (!transient(classifyConnectorError(error))) {
				output.error(
					`Stopped the Planner for ${document}: ${
						connectorMessage(error) ?? (error instanceof Error ? error.message : String(error))
					}`,
				);
				return;
			}
			let wait = backoff(attempt++);
			output.say(
				output.style.dim(`… Can't get a Planner credential for ${document}; retrying in `)
					+ output.style.dim(`${Math.ceil(wait / 1000)}s.`),
			);
			await delay(wait, signal);
			continue;
		}
		output.say(`› Planner for ${document} started.`);
		let code = await launch(options, credential.token);
		if (signal.aborted) return;
		if (Date.now() - started >= HEALTHY_MS) attempt = 0;
		let wait = backoff(attempt++);
		output.say(
			output.style.dim(
				`… Planner for ${document} exited (${code}); starting it again in ${
					Math.ceil(wait / 1000)
				}s.`,
			),
		);
		await delay(wait, signal);
	}
}

/** Run the backend once; resolves with how it exited. Aborting stops it, then kills it. */
async function launch(options: {
	url: string;
	document: string;
	command: string[];
	cwd: string;
	signal: AbortSignal;
}, token: string): Promise<string> {
	let child = spawn(options.command[0]!, options.command.slice(1), {
		cwd: options.cwd,
		env: {
			...process.env,
			CHOPIN_URL: options.url,
			CHOPIN_DOCUMENT: options.document,
			CHOPIN_PLANNER_TOKEN: token,
		},
		stdio: ["ignore", "inherit", "inherit"],
		// Its own process group, so Ctrl-C reaches it only through the connector stopping it.
		detached: process.platform !== "win32",
	});
	let exited = new Promise<string>(resolve => {
		child.once("error", error => resolve(error.message));
		child.once("exit", (code, name) => resolve(name ? `signal ${name}` : `code ${code}`));
	});
	let stop!: () => void;
	let stopped = new Promise<undefined>(resolve => {
		stop = () => resolve(undefined);
		options.signal.addEventListener("abort", stop, { once: true });
		if (options.signal.aborted) stop();
	});
	let how = await Promise.race([exited, stopped]);
	options.signal.removeEventListener("abort", stop);
	// A backend that exited by itself may leave children in its process group; they go too. On
	// Windows its process id may already belong to another process, so nothing more is stopped.
	if (how === undefined || process.platform !== "win32") await stopBackend(child);
	return how ?? await exited;
}

/** How a backend's processes are stopped: on which platform, running which commands, how patiently. */
export type Processes = {
	platform: NodeJS.Platform;
	/** Runs a command to its end; resolves with its exit code, or null when it could not run. */
	run(command: string[]): Promise<number | null>;
	/** How long a stopped process group has to exit before it is killed. */
	graceMs: number;
};

const PROCESSES: Processes = {
	platform: process.platform,
	run: command =>
		new Promise(resolve => {
			let child = spawn(command[0]!, command.slice(1), { stdio: "ignore", windowsHide: true });
			child.once("error", () => resolve(null));
			child.once("exit", code => resolve(code));
		}),
	graceMs: STOP_GRACE_MS,
};

/**
 * Stop a backend and everything it started. On POSIX its process group gets SIGTERM, then SIGKILL
 * after the grace period unless the whole group has gone by then, even when the backend itself
 * exited first. On Windows `taskkill /T /F` ends its process tree, or the backend alone when
 * taskkill cannot.
 */
export async function stopBackend(
	child: { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean },
	processes: Processes = PROCESSES,
): Promise<void> {
	let pid = child.pid;
	if (processes.platform === "win32") {
		let code = pid ? await processes.run(["taskkill", "/T", "/F", "/PID", String(pid)]) : null;
		if (code !== 0) {
			try {
				child.kill();
			} catch { /* It has already exited. */ }
		}
		return;
	}
	if (!pid || !signalGroup(pid, "SIGTERM")) return;
	for (let deadline = Date.now() + processes.graceMs; Date.now() < deadline;) {
		await new Promise(resolve => setTimeout(resolve, 50));
		if (!signalGroup(pid, 0)) return;
	}
	signalGroup(pid, "SIGKILL");
}

/** Signals process group `pgid`; false once no process is left in it. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
