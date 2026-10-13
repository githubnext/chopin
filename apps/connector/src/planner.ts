import { spawn } from "node:child_process";
import { redacted } from "./connection";
import { classifyConnectorError, connectorMessage, plannerCredential } from "./machine";
import { backoff, delay, HEALTHY_MS, transient } from "./reconnect";
import type { Output } from "./output";
import type { StartFailures } from "./workspace";

/** How long a stopped Planner backend has to exit before it is killed. */
const STOP_GRACE_MS = 5000;

/**
 * Split a `--planner-command` line into its words as a POSIX shell would, without expanding
 * anything: whitespace separates words; single quotes keep everything inside them; double quotes
 * keep everything but a backslash before `"`, `\`, `$` or a backquote; outside quotes a backslash
 * keeps the character after it. Quotes may sit inside a word, as `--label="two words"`. Throws
 * on an unmatched quote.
 */
export function commandWords(line: string): string[] {
	let words: string[] = [];
	let word: string | undefined;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index++) {
		let char = line[index]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
		} else if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\" && /["\\$`]/.test(line[index + 1] ?? "")) word += line[++index];
			else word += char;
		} else if (/\s/.test(char)) {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else {
			word ??= "";
			if (char === "'" || char === '"') quote = char;
			else if (char === "\\" && index + 1 < line.length) word += line[++index];
			else word += char;
		}
	}
	if (quote) {
		throw new Error(
			`--planner-command has an unmatched ${quote === "'" ? "single" : "double"} quote.`,
		);
	}
	if (word !== undefined) words.push(word);
	return words;
}

/**
 * Run `command` as each document's Planner backend until `signal` aborts. Every launch gets a fresh
 * Planner credential, passed only in its environment as CHOPIN_URL, CHOPIN_DOCUMENT and
 * CHOPIN_PLANNER_TOKEN. A backend that exits, as one whose link closed or whose credential was
 * refused does, is started again on the reconnect backoff. A revoked machine or a document Chopin
 * refuses stops that document's backend. One that exits within `healthyMs` is recorded in
 * `failures` for `chopin status`, until one stays up that long.
 */
export async function servePlanners(options: {
	url: string;
	machine: string;
	documents: string[];
	command: string[];
	cwd: string;
	output: Output;
	signal: AbortSignal;
	failures?: StartFailures;
	/** The `--env` variables connect saved, added to each backend's environment. */
	env?: Record<string, string>;
	healthyMs?: number;
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
	failures?: StartFailures;
	env?: Record<string, string>;
	healthyMs?: number;
}) {
	let { output, signal, document } = options;
	let healthyMs = options.healthyMs ?? HEALTHY_MS;
	let values = Object.values(options.env ?? {});
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
						redacted(
							connectorMessage(error) ?? (error instanceof Error ? error.message : String(error)),
							values,
						)
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
		let launched = Date.now();
		let healthy = setTimeout(() => void options.failures?.started(document), healthyMs);
		let { how, stderr } = await launch(options, credential.token);
		clearTimeout(healthy);
		if (signal.aborted) return;
		// What the backend printed may hold its credential or an --env value.
		let secrets = [credential.token, ...values];
		if (Date.now() - started >= HEALTHY_MS) attempt = 0;
		let wait = backoff(attempt++);
		if (Date.now() - launched < healthyMs) {
			let at = Date.now();
			await options.failures?.failed({
				kind: "planner",
				document,
				how,
				...(stderr ? { stderr } : {}),
				at,
				retryAt: at + wait,
			}, secrets);
		}
		output.say(
			output.style.dim(
				`… Planner for ${document} exited (${redacted(how, secrets)}); starting it again in ${
					Math.ceil(wait / 1000)
				}s.`,
			),
		);
		await delay(wait, signal);
	}
}

/**
 * Run the backend once; resolves with how it exited and the first line of its stderr, which
 * still reaches this process's own a line at a time, with its credential, the --env values and
 * anything token-shaped masked. Aborting stops it, then kills it.
 */
async function launch(options: {
	url: string;
	document: string;
	command: string[];
	cwd: string;
	signal: AbortSignal;
	env?: Record<string, string>;
}, token: string): Promise<{ how: string; stderr?: string }> {
	let child = spawn(options.command[0]!, options.command.slice(1), {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
			CHOPIN_URL: options.url,
			CHOPIN_DOCUMENT: options.document,
			CHOPIN_PLANNER_TOKEN: token,
		},
		stdio: ["ignore", "inherit", "pipe"],
		// Its own process group, so Ctrl-C reaches it only through the connector stopping it.
		detached: process.platform !== "win32",
	});
	let secrets = [token, ...Object.values(options.env ?? {})];
	let pass = (text: string) => text && process.stderr.write(redacted(text, secrets));
	let head = "";
	let pending = "";
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		if (head.length < 4096) head += chunk;
		// Whole lines, so a secret split between chunks is still masked.
		let end = (pending += chunk).lastIndexOf("\n") + 1;
		if (end || pending.length > 65_536) {
			pass(end ? pending.slice(0, end) : pending);
			pending = end ? pending.slice(end) : "";
		}
	});
	child.stderr!.once("end", () => pass(pending));
	let drained = new Promise(resolve => child.stderr!.once("close", resolve));
	let exited = new Promise<string>(resolve => {
		child.once("error", error => resolve(error.message));
		child.once("exit", (code, name) => resolve(name ? `signal ${name}` : `exit ${code}`));
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
	how ??= await exited;
	await Promise.race([drained, new Promise(resolve => setTimeout(resolve, 500))]);
	let stderr = head.split("\n").map(line => line.trim()).find(Boolean);
	return { how, ...(stderr ? { stderr } : {}) };
}

/** How a backend's processes are stopped: on which platform, running which commands, how patiently. */
export type Processes = {
	platform: NodeJS.Platform;
	/** Runs a command to its end; resolves with its exit code, or null when it could not run. */
	run(command: string[]): Promise<number | null>;
	/** How long a stopped process group has to exit before it is killed. */
	graceMs: number;
};

export const PROCESSES: Processes = {
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
 * exited first; it resolves once the group is gone, or a second after SIGKILL. On Windows
 * `taskkill /T /F` ends its process tree, or the backend alone when taskkill cannot.
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
	let gone = async (ms: number) => {
		for (let deadline = Date.now() + ms; Date.now() < deadline;) {
			await new Promise(resolve => setTimeout(resolve, 50));
			if (!signalGroup(pid, 0)) return true;
		}
		return false;
	};
	if (await gone(processes.graceMs) || !signalGroup(pid, "SIGKILL")) return;
	await gone(1000);
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
