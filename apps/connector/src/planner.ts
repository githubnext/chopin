import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { PlannerAssignment } from "@chopin/protocol/connector";
import { redacted } from "./connection";
import {
	classifyConnectorError,
	connectorMessage,
	plannerCredential,
	type PlannerStartFailure,
	reportPlannerFailure,
} from "./machine";
import { ConnectorError } from "./mcp";
import { backoff, delay, HEALTHY_MS, transient } from "./reconnect";
import type { Output } from "./output";
import { gitCredentials, type GitHubToken, githubToken } from "./github-token";
import { type PlannerTokenFile, plannerTokenFile } from "./planner-token";
import {
	type ChosenPlanners,
	plannerWorktree,
	preparePlannerWorktree,
	type StartFailures,
	tokenFolder,
} from "./workspace";
import type { Checkouts } from "./checkouts";
import { type Sandbox, spawnIn } from "./sandbox";

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
 * CHOPIN_PLANNER_TOKEN, beside CHOPIN_CHECKOUT, the checkout of the document's repository it runs
 * in (registered, or cloned and fetched again before each launch; see `checkouts`), and
 * CHOPIN_WORKTREE, where the backend keeps its own worktree of it (see `plannerWorktree`). A
 * backend that exits, as
 * one whose link closed or whose credential was refused does, is started again on the reconnect
 * backoff. A revoked machine or a document Chopin refuses stops that document's backend. One that
 * exits within `healthyMs` is recorded in `failures` for `chopin status`, until one stays up that
 * long.
 */
export async function servePlanners(options: {
	url: string;
	machine: string;
	documents: string[];
	command: string[];
	/** The checkout of each document's repository, which its backend runs in. */
	checkouts: Checkouts;
	/** The connector's base dir, which holds the Planners' worktrees. */
	directory: string;
	output: Output;
	signal: AbortSignal;
	failures?: StartFailures;
	/** The `--env` variables connect saved, added to each backend's environment. */
	env?: Record<string, string>;
	healthyMs?: number;
	/** Hears, once each time, why Chopin gave no GitHub token when its App can't push. */
	githubRefused?: (message: string, repository: string) => void;
	/** How long before it expires the GitHub token is replaced; for tests. */
	renewGitHubBeforeMs?: number;
	/** Where each backend starts: the machine's process sandbox, else plainly. */
	sandbox?: Sandbox;
}) {
	await Promise.all(options.documents.map(document => servePlanner({ ...options, document })));
}

/**
 * The Planners Chopin asks this machine to run, for documents its owner chose it for: `assign`
 * starts a backend, as `servePlanners` does, for each document new to the list and stops each
 * one no longer on it, saying so in chopin's output. `running` names the documents asked for, by
 * id, for the next Planner poll. A document `--planner` already runs is never started twice.
 * `chosen` keeps the documents it started, for `chopin status`. `stop` stops them all.
 *
 * A backend that exits by itself starts again only once Chopin still asks for it: Chopin closes
 * the link of a Planner it stops asking for, so the exit can come before the poll's answer. Until
 * an answer, `running` leaves the document out, which Chopin answers at once if it still wants it;
 * `unchanged` hears an answer that changed nothing, so one that leaves it out withdraws it.
 * `retry` names the documents a person asked to have started again now: one that exited starts
 * without waiting out its backoff, and one that is running is left as it is.
 */
export function dispatchedPlanners(options: {
	url: string;
	machine: string;
	/** The `--planner` documents, by URL or id, which run on their own. */
	documents: string[];
	command: string[];
	checkouts: Checkouts;
	directory: string;
	output: Output;
	signal: AbortSignal;
	failures?: StartFailures;
	chosen?: ChosenPlanners;
	env?: Record<string, string>;
	healthyMs?: number;
	/** Hears, once each time, why Chopin gave no GitHub token when its App can't push. */
	githubRefused?: (message: string, repository: string) => void;
	/** How long before it expires the GitHub token is replaced; for tests. */
	renewGitHubBeforeMs?: number;
	sandbox?: Sandbox;
}) {
	type Backend = {
		url: string;
		own: boolean;
		stop: AbortController;
		served: Promise<void>;
		/** Set while it exited by itself and waits on Chopin's answer: whether to start it again. */
		exited?: (again: boolean) => void;
		/** Set while it waits out its backoff before starting again: cuts that wait short. */
		hurry?: () => void;
		/** A person asked for it again while it waited on Chopin's answer: skip the next backoff. */
		hurried?: boolean;
	};
	let running = new Map<string, Backend>();
	let own = new Set(options.documents);
	let withdraw = (id: string, backend: Backend, reason?: string) => {
		running.delete(id);
		backend.stop.abort();
		if (!backend.own && !options.signal.aborted) {
			options.output.say(
				`Stopped the Planner for ${backend.url}: ${
					typeof reason === "string" && reason.trim()
						? reason.trim()
						: "Chopin no longer asks this machine to run it."
				}`,
			);
		}
	};
	let record = () =>
		void options.chosen?.record(
			[...running.values()].filter(backend => !backend.own).map(backend => backend.url),
		);
	return {
		running: () => [...running].filter(([, backend]) => !backend.exited).map(([id]) => id),
		assign(planners: PlannerAssignment[], stopped?: Record<string, string>, retry?: string[]) {
			let wanted = new Map(planners.map(value => [value.id, value]));
			let now = new Set(retry);
			for (let [id, backend] of running) {
				let planner = wanted.get(id);
				if (!planner) {
					withdraw(id, backend, stopped?.[id]);
					continue;
				}
				// A renamed document keeps its id; Chopin names its new address.
				if (!backend.own) backend.url = planner.url;
				// Only a backend that is not running is hurried: a running one may hold work.
				if (now.has(id)) {
					if (backend.hurry) backend.hurry();
					else if (backend.exited) backend.hurried = true;
				}
				backend.exited?.(true);
			}
			for (let [id, planner] of wanted) {
				if (running.has(id) || options.signal.aborted) continue;
				let stop = new AbortController();
				let mine = own.has(id) || own.has(planner.url);
				let backend: Backend = { url: planner.url, own: mine, stop, served: Promise.resolve() };
				let signal = AbortSignal.any([options.signal, stop.signal]);
				if (!mine) {
					backend.served = servePlanner({
						...options,
						document: planner.url,
						address: () => backend.url,
						id: planner.id,
						signal,
						pause: async (ms: number) => {
							let now = () =>
								options.output.say(
									options.output.style.dim(
										`… Starting the Planner for ${backend.url} again now, as someone asked.`,
									),
								);
							if (backend.hurried) {
								backend.hurried = false;
								now();
								return;
							}
							let cut = new AbortController();
							backend.hurry = () => {
								now();
								cut.abort();
							};
							await delay(ms, AbortSignal.any([signal, cut.signal]));
							backend.hurry = undefined;
						},
						again: () =>
							new Promise<boolean>(resolve => {
								let answer = (again: boolean) => {
									backend.exited = undefined;
									signal.removeEventListener("abort", stopped);
									resolve(again);
								};
								let stopped = () => answer(false);
								backend.exited = answer;
								signal.addEventListener("abort", stopped, { once: true });
								if (signal.aborted) stopped();
							}),
					});
				}
				running.set(id, backend);
			}
			record();
		},
		/** Chopin answered a Planner poll naming `asked` with no change: it wants exactly those. */
		unchanged(asked: string[]) {
			let wanted = new Set(asked);
			let withdrawn = false;
			for (let [id, backend] of running) {
				if (!backend.exited) continue;
				if (wanted.has(id)) backend.exited(true);
				else {
					withdraw(id, backend);
					withdrawn = true;
				}
			}
			if (withdrawn) record();
		},
		async stop() {
			for (let backend of running.values()) backend.stop.abort();
			await Promise.all([...running.values()].map(backend => backend.served));
			running.clear();
			await options.chosen?.record([]);
		},
	};
}

async function servePlanner(options: {
	url: string;
	machine: string;
	document: string;
	/** The document's id in Chopin, when known before its credential names it. */
	id?: string;
	/** The document's current address, when Chopin can name a new one as it is renamed. */
	address?: () => string;
	command: string[];
	checkouts: Checkouts;
	directory: string;
	output: Output;
	signal: AbortSignal;
	failures?: StartFailures;
	env?: Record<string, string>;
	healthyMs?: number;
	/** Hears, once each time, why Chopin gave no GitHub token when its App can't push. */
	githubRefused?: (message: string, repository: string) => void;
	/** How long before it expires the GitHub token is replaced; for tests. */
	renewGitHubBeforeMs?: number;
	sandbox?: Sandbox;
	/**
	 * For a dispatched Planner: once the backend exits by itself, whether Chopin still asks for it,
	 * so it starts again. Without it, a backend that exits is always started again.
	 */
	again?: () => Promise<boolean>;
	/** Waits out a backoff before starting again, which a person's asking may cut short. */
	pause?: (ms: number) => Promise<void>;
}) {
	let { output, signal } = options;
	let healthyMs = options.healthyMs ?? HEALTHY_MS;
	let values = Object.values(options.env ?? {});
	let current = () => options.address?.() ?? options.document;
	let pause = options.pause ?? ((ms: number) => delay(ms, signal));
	// Launches in a row that exited before staying up, and whether Chopin was told of them.
	let streak = 0;
	let reported = false;
	let unsupported = false;
	// Best effort: a person reading the document, not the Planner, is who this is for.
	let report = (document: string, failure: PlannerStartFailure | undefined) => {
		if (unsupported || signal.aborted) return;
		void reportPlannerFailure(
			options.url,
			options.machine,
			document,
			failure,
			AbortSignal.any([signal, AbortSignal.timeout(REPORT_MS)]),
		).catch(error => {
			// A server from before the report does not know the route, and never will.
			if (error instanceof ConnectorError && error.status === 404) unsupported = true;
		});
	};
	for (let attempt = 0; !signal.aborted;) {
		let document = current();
		let started = Date.now();
		let credential;
		try {
			credential = await plannerCredential(options.url, options.machine, document, signal);
		} catch (error) {
			if (signal.aborted) return;
			if (!transient(classifyConnectorError(error))) {
				let reason = redacted(
					connectorMessage(error) ?? (error instanceof Error ? error.message : String(error)),
					values,
				);
				output.error(`Stopped the Planner for ${document}: ${reason}`);
				// Status shows it stopped, not still retrying an earlier failed start.
				await options.failures?.failed({
					kind: "planner",
					document,
					how: reason,
					stopped: true,
					at: Date.now(),
				});
				return;
			}
			let wait = backoff(attempt++);
			output.say(
				output.style.dim(`… Can't get a Planner credential for ${document}; retrying in `)
					+ output.style.dim(`${Math.ceil(wait / 1000)}s.`),
			);
			await pause(wait);
			continue;
		}
		// Chopin names the document's repository, whose checkout the backend runs in.
		let repository = credential.repository ?? "";
		// Reports name the document by its id, which Chopin can check without asking GitHub.
		let reportedAs = credential.document ?? options.id ?? document;
		let worktree = await plannerWorktree(
			options.directory,
			repository,
			credential.document ?? options.id ?? document,
		);
		// Its tokens are kept in a folder of their own, which is all of them a sandbox is shown.
		let tokenDirectory = tokenFolder(worktree);
		await mkdir(tokenDirectory, { recursive: true, mode: 0o700 }).catch(() => {});
		// The machine's own GitHub token, where Chopin gives one; without one the backend still starts
		// in a registered checkout.
		let github = await githubToken({
			url: options.url,
			machine: options.machine,
			repository,
			file: join(tokenDirectory, "github"),
			...(options.githubRefused ? { refused: options.githubRefused } : {}),
			...(options.renewGitHubBeforeMs === undefined
				? {}
				: { renewBeforeMs: options.renewGitHubBeforeMs }),
		});
		let launched = Date.now();
		let tokens: PlannerTokenFile | undefined;
		let outcome: { how: string; stderr?: string; reason?: string };
		let checkout = await options.checkouts.resolve(repository, async () => github).then(
			value => value.root,
			(error: unknown) => {
				outcome = { how: error instanceof Error ? error.message : String(error) };
				return undefined;
			},
		);
		if (checkout) {
			output.say(`› Planner for ${document} started.`);
			let healthy = setTimeout(() => {
				void options.failures?.started(document);
				// Once it stays up, what was told to Chopin about its failing is no longer true.
				if (reported) {
					reported = false;
					report(reportedAs, undefined);
				}
			}, healthyMs);
			// The backend may outlive its credential when its link drops, so it can read a new one.
			tokens = await plannerTokenFile({
				url: options.url,
				machine: options.machine,
				document,
				file: join(tokenDirectory, "planner"),
				first: credential,
			});
			// A backend in the sandbox can't make its own worktree of the checkout (see
			// `preparePlannerWorktree`), so it is made here. Never fatal: a backend that has no use
			// for one starts all the same, and one that has says why itself.
			if (options.sandbox && options.sandbox.report.engine !== "none") {
				await preparePlannerWorktree(checkout, worktree).catch(error =>
					output.say(
						output.style.dim(
							`… Couldn't make the worktree for ${document}'s Planner: ${
								redacted(error instanceof Error ? error.message : String(error)).split("\n")[0]
							}`,
						),
					)
				);
			}
			outcome = await launch(
				{ ...options, document, cwd: checkout },
				credential.token,
				worktree,
				github,
				repository,
				tokens,
			);
			await tokens?.stop();
			clearTimeout(healthy);
		} else {
			output.error(`Can't start the Planner for ${document}: ${outcome!.how}`);
		}
		let { how, stderr, reason } = outcome!;
		await github?.stop();
		if (signal.aborted) return;
		// Renamed while it ran: say so by its new address.
		document = current();
		// What the backend printed may hold its credential, a GitHub token or an --env value.
		let secrets = [
			credential.token,
			...tokens?.secrets() ?? [],
			...github?.secrets() ?? [],
			...values,
		];
		let ended = Date.now();
		let early = ended - launched < healthyMs;
		streak = early ? streak + 1 : 0;
		let failed = (at: number, retryAt?: number) =>
			options.failures?.failed({
				kind: "planner",
				document,
				how,
				...(stderr ? { stderr } : {}),
				at,
				...(retryAt === undefined ? {} : { retryAt }),
			}, secrets);
		if (options.again) {
			// Status shows a failed start while Chopin is asked whether it still wants this Planner.
			if (early) await failed(ended);
			if (!(await options.again())) return;
			document = current();
		}
		if (ended - started >= HEALTHY_MS) attempt = 0;
		let wait = backoff(attempt++);
		if (early) {
			let at = Date.now();
			await failed(at, at + wait);
			// What Chopin's people read in the document: why, and how often in a row.
			reported = true;
			report(reportedAs, {
				attempts: streak,
				how: plain(redacted(how, secrets)),
				...(reason ? { reason: plain(redacted(reason, secrets)) } : {}),
				at: ended,
			});
		}
		output.say(
			output.style.dim(
				`… Planner for ${document} exited (${redacted(how, secrets)}); starting it again in ${
					Math.ceil(wait / 1000)
				}s.`,
			),
		);
		await pause(wait);
	}
}

/** How many of a backend's last stderr lines are kept to find why it exited. */
const TAIL_LINES = 8;
/** How long the connector waits on Chopin to take a report of a failing Planner backend. */
const REPORT_MS = 10_000;
/** The longest reason or `how` told to Chopin, in characters. */
const REASON_CHARS = 300;

// Terminal colors and other control characters are what a backend's colored output adds.
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const TIMESTAMP =
	/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/;
/** A line that only announces the backend is leaving, which is never why. */
const LEAVING = /^(?:exiting|exited|shutting down|terminating|aborting|quitting)\b/i;

/**
 * The line of a backend's last stderr output that says why it exited: the last one that is not
 * blank and does not merely announce that it is exiting, without its colors or leading time, else
 * the last line. Undefined when it printed nothing.
 */
export function startFailureReason(lines: string[]): string | undefined {
	let cleaned = lines
		.map(line => line.replace(ANSI, "").replace(TIMESTAMP, "").replace(CONTROL, " ").trim())
		.filter(Boolean);
	return cleaned.findLast(line => !LEAVING.test(line)) ?? cleaned.at(-1);
}

/** Text told to Chopin: the home directory as `~`, and short. Mask secrets before this. */
function plain(text: string, home = homedir()) {
	let shown = home.length > 1 ? text.replaceAll(home, "~") : text;
	return shown.length > REASON_CHARS ? `${shown.slice(0, REASON_CHARS - 1)}…` : shown;
}

/** Longer than this, a backend's output line is dropped rather than passed on unmasked. */
const LONGEST_LINE = 65_536;

/**
 * Pass a backend's stdout or stderr on to this process's own a line at a time, with `secrets` and
 * anything token-shaped masked; `heard` hears the text as passed on. A line too long to hold whole
 * is dropped, a marker in its place, since a secret split across it could not be masked. Resolves
 * once the stream closes.
 */
function passMasked(
	stream: Readable,
	name: "stdout" | "stderr",
	secrets: () => string[],
	heard?: (text: string) => void,
): Promise<unknown> {
	let dropped = `[chopin: dropped a ${name} line longer than ${LONGEST_LINE} characters]`;
	let pass = (text: string) => {
		heard?.(text);
		if (text) process[name].write(redacted(text, secrets()));
	};
	let pending = "";
	let dropping = false;
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		// Whole lines, so a secret split between chunks is still masked.
		let lines = (pending + chunk).split("\n");
		pending = lines.pop()!;
		let whole: string[] = [];
		for (let line of lines) {
			// The first newline ends a line already dropped.
			if (dropping) dropping = false;
			else whole.push(line.length > LONGEST_LINE ? dropped : line);
		}
		if (pending.length > LONGEST_LINE) {
			if (!dropping) whole.push(dropped);
			dropping = true;
			pending = "";
		}
		if (whole.length) pass(whole.map(line => `${line}\n`).join(""));
	});
	stream.once("end", () => dropping || pass(pending));
	return new Promise(resolve => stream.once("close", resolve));
}

/**
 * Run the backend once; resolves with how it exited, the first line of its stderr and the one that
 * says why it exited (see `startFailureReason`). Its stdout
 * and stderr still reach this process's own, masked by `passMasked`: its credential, the --env
 * values and anything token-shaped. Aborting stops it, then kills it.
 */
async function launch(
	options: {
		url: string;
		document: string;
		command: string[];
		cwd: string;
		signal: AbortSignal;
		env?: Record<string, string>;
		sandbox?: Sandbox;
	},
	token: string,
	worktree: string,
	github?: GitHubToken,
	repository?: string,
	tokens?: PlannerTokenFile,
): Promise<{ how: string; stderr?: string; reason?: string }> {
	let child;
	try {
		child = spawnIn(options.sandbox, {
			command: options.command,
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env,
				// Its own git, and its agent's, reach GitHub with this token over https, whatever
				// the person's Git configuration says about GitHub URLs or SSH.
				...(github && repository ? gitCredentials(github.file, repository) : {}),
				CHOPIN_URL: options.url,
				CHOPIN_DOCUMENT: options.document,
				CHOPIN_PLANNER_TOKEN: token,
				...(tokens ? { CHOPIN_PLANNER_TOKEN_FILE: tokens.file } : {}),
				CHOPIN_CHECKOUT: options.cwd,
				CHOPIN_WORKTREE: worktree,
				...(github
					? {
						CHOPIN_GITHUB_TOKEN: github.token,
						CHOPIN_GITHUB_TOKEN_EXPIRES_AT: new Date(github.expiresAt).toISOString(),
						CHOPIN_GITHUB_TOKEN_FILE: github.file,
					}
					: {}),
			},
			stdin: "ignore",
			// It writes its own worktree, which the connector made for it, and nothing of the checkout
			// it runs in, which is the person's and read-only; it sees nothing of its siblings' or of
			// anyone's tokens but its own.
			writable: [worktree],
			own: [worktree, tokenFolder(worktree)],
		});
	} catch (error) {
		return { how: error instanceof Error ? error.message : String(error) };
	}
	// Read as each line is passed on, so a GitHub token renewed meanwhile is masked too.
	let secrets = () => [
		token,
		...tokens?.secrets() ?? [],
		...github?.secrets() ?? [],
		...Object.values(options.env ?? {}),
	];
	let first: string | undefined;
	// The last lines it printed, for the one that says why it exited.
	let tail: string[] = [];
	let drained = Promise.all([
		passMasked(child.stdout!, "stdout", secrets),
		passMasked(child.stderr!, "stderr", secrets, text => {
			let lines = text.split("\n").map(line => line.trim()).filter(Boolean);
			first ??= lines[0];
			tail.push(...lines.map(line => line.slice(0, 1000)));
			if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
		}),
	]);
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
	let reason = startFailureReason(tail);
	return { how, ...(first ? { stderr: first } : {}), ...(reason ? { reason } : {}) };
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
