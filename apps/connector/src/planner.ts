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
function launch(options: {
	url: string;
	document: string;
	command: string[];
	cwd: string;
	signal: AbortSignal;
}, token: string) {
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
	let kill = (name: NodeJS.Signals) => {
		try {
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
			else child.kill(name);
		} catch { /* It has already exited. */ }
	};
	return new Promise<string>(resolve => {
		let force: ReturnType<typeof setTimeout> | undefined;
		let stop = () => {
			kill("SIGTERM");
			force = setTimeout(() => kill("SIGKILL"), STOP_GRACE_MS);
		};
		options.signal.addEventListener("abort", stop, { once: true });
		if (options.signal.aborted) stop();
		let done = (how: string) => {
			clearTimeout(force);
			options.signal.removeEventListener("abort", stop);
			resolve(how);
		};
		child.once("error", error => done(error.message));
		child.once("exit", (code, name) => done(name ? `signal ${name}` : `code ${code}`));
	});
}
