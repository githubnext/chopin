import { appendFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AGENTS } from "@chopin/protocol/agents";
import { checkAgent } from "./acp";
import { ConnectorStopped, redacted, serveWork } from "./connection";
import { remote } from "./mcp";
import { parseArgs } from "./args";
import {
	connectorMessage,
	forget,
	machineToken,
	pair,
	pairingKey,
	register,
	SELF,
	unpair,
} from "./machine";
import { createOutput } from "./output";
import { permissionMemory } from "./permission";
import { commandWords, servePlanners } from "./planner";
import { runWork } from "./run";
import { implementationBridge } from "./implementation";
import { readConfig, updateConfig } from "./config";
import {
	CONNECT_FIRST,
	installService,
	logPath,
	onStopRequest,
	programAt,
	restartAfterUpdate,
	restartService,
	ServiceError,
	type ServiceHost,
	serviceStatus,
	stablePath,
	systemHost,
	uninstallService,
} from "./service";
import { collectStatus, formatStatus, type ServerSource } from "./status";
import { removeReplaced, update } from "./update";
import { VERSION } from "./version";
import { connectors, lockWorkspace, startFailures, stateDirectory, workspace } from "./workspace";

const DEFAULT_URL = "https://chopin.githubnext.com";

function origin(value: string) {
	let url = new URL(value);
	if (
		url.username || url.password || url.search || url.hash || url.pathname !== "/"
		|| url.protocol !== "https:"
			&& !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	) {
		throw new Error("CHOPIN_URL must be an HTTPS origin (HTTP is allowed on loopback).");
	}
	return url.origin;
}

async function bridge() {
	let api = await remote(
		origin(process.env.CHOPIN_BRIDGE_ORIGIN!),
		process.env.CHOPIN_BRIDGE_TOKEN!,
	);
	let server = await implementationBridge(api, process.env.CHOPIN_BRIDGE_ROOT);
	await server.connect(new StdioServerTransport());
	let close = async () => {
		await server.close();
		await api.close();
	};
	process.once("SIGTERM", () => void close());
	process.once("SIGINT", () => void close());
}

/** CHOPIN_URL, else the server `chopin connect` saved, else Chopin's own. */
async function chosenServer(): Promise<{ origin: string; source: ServerSource }> {
	if (process.env.CHOPIN_URL) {
		return { origin: origin(process.env.CHOPIN_URL), source: "CHOPIN_URL" };
	}
	let stored = (await readConfig(stateDirectory())).connect?.server;
	return stored
		? { origin: origin(stored), source: "config" }
		: { origin: DEFAULT_URL, source: "default" };
}

async function server() {
	return (await chosenServer()).origin;
}

/** `status [--json]`: this machine's chopin, pairing, connectors, service and log. */
async function statusCommand(args: string[]) {
	let parsed = parseArgs(args, { flags: ["json"] });
	if (parsed.positional.length || parsed.rest) throw new Error(`Usage: ${SELF} status [--json]`);
	let chosen = await chosenServer();
	let report = await collectStatus({
		directory: stateDirectory(),
		server: chosen.origin,
		source: chosen.source,
		host: systemHost(),
	});
	if (parsed.flags.has("json")) console.log(JSON.stringify(report, null, 2));
	else createOutput().say(...formatStatus(report));
}

/** Under Task Scheduler nothing collects output, so the Windows service appends it to its log. */
function appendOutput(path: string) {
	let write = (chunk: string | Uint8Array) => {
		try {
			appendFileSync(path, chunk);
		} catch { /* A full or vanished log must not stop the connector. */ }
		return true;
	};
	process.stdout.write = write as typeof process.stdout.write;
	process.stderr.write = write as typeof process.stderr.write;
}

/** Interrupt a command at the first Ctrl-C; a second exits at once. */
function interruptible() {
	let abort = new AbortController();
	let stop = () => {
		if (abort.signal.aborted) process.exit(130);
		abort.abort();
		process.once("SIGINT", () => process.exit(130));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	return {
		signal: abort.signal,
		done() {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
		},
	};
}

/**
 * `pair [--label <name>] [--key <key>]`: pair this machine and store its token, replacing any
 * earlier one. With a pairing key (or CHOPIN_PAIRING_KEY) it needs no browser.
 */
async function pairCommand(args: string[]) {
	let parsed = parseArgs(args, { options: ["label", "key"] });
	if (parsed.positional.length || parsed.rest) {
		throw new Error(`Usage: ${SELF} pair [--label <name>] [--key <pairing key>]`);
	}
	let key = pairingKey(parsed.options.get("key"));
	let output = createOutput();
	let label = parsed.options.get("label") ?? hostname();
	let run = interruptible();
	try {
		let token = await pair({
			url: await server(),
			label,
			directory: stateDirectory(),
			output,
			signal: run.signal,
			key,
		});
		if (token) output.say(`${output.style.green("✓ Paired.")} This machine is ${label} in Chopin.`);
	} finally {
		run.done();
	}
}

/** `unpair`: revoke this machine's token on the server and delete it here. */
async function unpairCommand(args: string[]) {
	let parsed = parseArgs(args);
	if (parsed.positional.length || parsed.rest) throw new Error(`Usage: ${SELF} unpair`);
	let url = await server();
	let result = await unpair(url, stateDirectory());
	createOutput().say(
		result === "unpaired"
			? `Unpaired this machine from ${url}.`
			: `This machine is not paired with ${url}.`,
	);
}

/**
 * `command` with its program, or the one behind `env`, by its stable path when this shell finds
 * it only through a per-shell or temporary directory, as fnm's, saying so. One with no stable
 * path is kept, with a warning, as service install would refuse it.
 */
async function stableCommand(command: string[], base: string) {
	let at = programAt(command);
	let word = command[at]!;
	let found = /[\\/]/.test(word) ? resolve(base, word) : Bun.which(word);
	if (!found) return command;
	let host = systemHost();
	let seen = await stablePath(host.platform, host.env, found);
	if (!seen) return command;
	if ("fleeting" in seen) {
		createOutput().error(
			`${word} is ${found}, which lasts only as long as this shell, so chopin service install `
				+ "will refuse it.",
		);
		return command;
	}
	createOutput().say(
		`Saved ${word} as ${seen.stable}, since ${found} lasts only as long as this shell.`,
	);
	return [...command.slice(0, at), seen.stable, ...command.slice(at + 1)];
}

/**
 * Stop before anything is paired or connected when `command`'s program, or the one behind `env`,
 * isn't installed, so a pairing key is never spent on a machine that can't run work. A coding
 * agent from the Machines page's list is named with its install and sign-in commands.
 */
function requireProgram(command: string[], base: string) {
	let word = command[programAt(command)];
	if (!word) return;
	// The PATH as it is now, which a process (or a test) may have changed since it started.
	let found = /[\\/]/.test(word)
		? existsSync(resolve(base, word))
		: Bun.which(word, { PATH: process.env.PATH ?? "" });
	if (found) return;
	let name = basename(word).replace(/\.(exe|cmd|bat)$/i, "");
	let agent = AGENTS.find(item => item.acp[0] === name);
	if (!agent) {
		throw new Error(
			`${word} isn't on your PATH, so nothing was paired or connected. Install it or give its `
				+ "full path, then run this command again.",
		);
	}
	let { command: signIn, afterward } = agent.signIn;
	throw new Error(
		[
			`${word} isn't installed, so nothing was paired or connected. Install ${agent.name} and `
			+ "sign in to it:",
			...agent.install.map(install => `  ${install.join(" ")}`),
			`  ${signIn.join(" ")}${afterward ? `  (${afterward})` : ""}`,
			"Then run this command again.",
		].join("\n"),
	);
}

/**
 * `--env KEY=VALUE` words as variables. Chopin sets CHOPIN_* itself and the service sets PATH, so
 * neither can be given.
 */
function environment(words: string[]) {
	let env: Record<string, string> = {};
	for (let word of words) {
		let at = word.indexOf("=");
		let key = at < 0 ? word : word.slice(0, at);
		if (at < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`--env takes KEY=VALUE, with a KEY of letters, digits and _; not "${word}".`);
		}
		if (key.toUpperCase() === "PATH" || key.toUpperCase().startsWith("CHOPIN_")) {
			throw new Error(`--env can't set ${key}; chopin sets it.`);
		}
		env[key] = word.slice(at + 1);
	}
	return env;
}

/**
 * `connect`. `--service` marks the connector the installed service runs, which runs what install
 * copied. `--install-service` installs the service once connected, then stops; `injected` stands
 * in for this machine's service manager and chopin in tests.
 */
export async function connect(
	args: string[],
	injected: { host?: ServiceHost; executable?: string } = {},
) {
	let parsed = parseArgs(args, {
		flags: ["service", "install-service", "skip-check"],
		options: ["planner-command", "key"],
		lists: ["planner", "env"],
	});
	let service = parsed.flags.has("service");
	let directory = stateDirectory();
	let saved = service ? (await readConfig(directory)).service?.settings : undefined;
	if (
		service
		&& (parsed.positional.length || parsed.rest || parsed.lists.size
			|| parsed.options.has("planner-command") || parsed.options.has("key")
			|| parsed.flags.has("install-service") || parsed.flags.has("skip-check"))
	) {
		throw new Error(
			`${SELF} connect --service takes no other arguments; it runs what ${SELF} service install saved.`,
		);
	}
	if (service && !saved) throw new Error(CONNECT_FIRST);
	// Read once and cleared from the environment, so neither the agent nor the service sees it.
	let key = pairingKey(parsed.options.get("key"));
	let installing = parsed.flags.has("install-service");
	let executable = injected.executable ?? installedChopin();
	if (installing && !executable) throw new ServiceError(NOT_INSTALLED);
	/** Set once connected under --install-service, which then stops to install. */
	let install = false;
	let command = saved?.command ?? parsed.rest ?? JSON.parse(process.env.CHOPIN_ACP_COMMAND ?? "[]");
	if (
		!Array.isArray(command) || !command.length
		|| command.some(item => typeof item !== "string" || !item)
	) {
		throw new Error(USAGE);
	}
	let plannerDocuments = saved?.planners ?? parsed.lists.get("planner") ?? [];
	let plannerLine = parsed.options.get("planner-command");
	let plannerCommand = saved?.plannerCommand ?? (plannerLine === undefined
		? JSON.parse(process.env.CHOPIN_PLANNER_COMMAND ?? "[]")
		: commandWords(plannerLine));
	if (
		!Array.isArray(plannerCommand)
		|| plannerCommand.some(item => typeof item !== "string" || !item)
		|| !!plannerDocuments.length !== !!plannerCommand.length
	) {
		throw new Error(
			`--planner <document URL> and --planner-command <command> go together.\n\n${USAGE}`,
		);
	}
	let env = saved?.env ?? environment(parsed.lists.get("env") ?? []);
	if (!service) {
		requireProgram(command, process.cwd());
		if (plannerCommand.length) requireProgram(plannerCommand, resolve(parsed.positional[0] ?? "."));
	}
	if (service && process.platform === "win32") appendOutput(logPath("win32", directory));
	let url = saved?.server ?? await server();
	let info = await workspace(resolve(saved?.checkout ?? parsed.positional[0] ?? "."));
	// The service runs what a terminal's connect saves. A relative agent path would resolve
	// against the service's own working directory.
	let agent = command[0]!;
	let saving = service ? { command, plannerCommand } : {
		command: await stableCommand(
			!isAbsolute(agent) && (agent.includes("/") || agent.includes(sep))
				? [resolve(agent), ...command.slice(1)]
				: command,
			process.cwd(),
		),
		plannerCommand: plannerCommand.length
			? await stableCommand(plannerCommand, info.root)
			: plannerCommand,
	};
	let save = () =>
		updateConfig(directory, value => {
			value.connect = {
				server: url,
				checkout: info.root,
				command: saving.command,
				planners: plannerDocuments,
				plannerCommand: saving.plannerCommand,
				...(Object.keys(env).length ? { env } : {}),
			};
		});
	if (
		!service
		&& (await connectors(directory)).some(item =>
			item.service && item.running && item.root === info.root
		)
	) {
		await save();
		createOutput().say(
			"The chopin service is running this checkout. Saved your settings; run chopin service "
				+ "install to use them.",
		);
		return;
	}
	// The service install check runs only once connected; a machine about to pair checks first, so
	// a pairing key isn't spent on an agent that can't start.
	if (installing && !parsed.flags.has("skip-check") && !await machineToken(directory, url)) {
		let failed = await checkAgent(saving.command, {
			cwd: info.root,
			env: { ...process.env, ...env },
			timeoutMs: 10_000,
		});
		if (failed) {
			let secrets = Object.values(env);
			throw new Error(
				`${command[programAt(command)]} didn't answer ACP initialize (${
					redacted(failed.how, secrets)
				}${failed.stderr ? `: ${redacted(failed.stderr, secrets).slice(0, 200)}` : ""}). `
					+ "Nothing was paired. Check that it starts and is signed in, then run this command "
					+ "again. For an agent that can't start without a terminal, pass --skip-check.",
			);
		}
	}
	let release = await lockWorkspace(info.root, directory, { service, planners: plannerDocuments });
	let failures = startFailures(directory, info.root);
	let abort = new AbortController();
	// The first Ctrl-C reports running work as stopped, then disconnects; a second forces exit.
	let stop = () => {
		if (abort.signal.aborted) process.exit(130);
		abort.abort();
		process.once("SIGINT", () => process.exit(130));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	// Task Scheduler ends a task without a signal, so `service restart` asks through a file.
	let unwatch = service ? onStopRequest(directory, stop) : () => {};
	let output = createOutput();
	let permissions = permissionMemory();
	try {
		let { root: _root, ...source } = info;
		let checkout = { ...source, label: basename(info.root) };
		for (;;) {
			// A machine paired once reconnects with its stored token; an unpaired one pairs first.
			let stored = await machineToken(directory, url);
			// The service has no terminal to pair on, so it stops rather than wait on a browser.
			if (!stored && service && !(process.stdin.isTTY && process.stdout.isTTY)) {
				throw new Error(
					`This machine is not paired with ${url}. Run \`${SELF} pair\` at a terminal, then `
						+ `\`${SELF} service restart\`.`,
				);
			}
			if (stored && key) {
				output.say(`This machine is already paired with ${url}, so the pairing key wasn't used.`);
			}
			let machine = stored
				?? await pair({
					url,
					label: hostname(),
					directory,
					output,
					signal: abort.signal,
					checkout: source,
					key,
				});
			if (!machine) return;
			// A key pairs once; pairing again after a revocation goes by the browser.
			key = undefined;
			let announced = false;
			// Planner backends run beside the work loop with this machine token and stop with it, so
			// none outlives a revoked token and a machine paired again starts them with its new one.
			let planners = new AbortController();
			let planning = servePlanners({
				url,
				machine,
				documents: plannerDocuments,
				command: plannerCommand,
				cwd: info.root,
				output,
				signal: AbortSignal.any([abort.signal, planners.signal]),
				failures,
				env,
			});
			try {
				await serveWork({
					// Every connection registers anew with the machine token: a connection token lasts only
					// while the server runs, so after a restart Chopin refuses the old one for good.
					connect: async signal => {
						let api = await remote(url, await register(url, machine, checkout, signal), signal);
						if (!announced) {
							output.connected(info.repository);
							// Only a connect that got this far saves its settings for service install.
							if (!service) await save();
							// The connection disconnects once it is serving, then the service installs.
							if (installing) {
								install = true;
								setTimeout(() => abort.abort(), 0);
							}
						}
						announced = true;
						return api;
					},
					signal: abort.signal,
					output,
					run: (api, kind, claim) =>
						runWork(api, kind, claim, {
							root: info.root,
							directory,
							command,
							url,
							signal: abort.signal,
							output,
							permissions,
							interrupt: stop,
							failures,
							env,
						}),
				});
				break;
			} catch (error) {
				if (!(error instanceof ConnectorStopped && error.reason === "revoked")) throw error;
				// Chopin no longer accepts the token, so it is forgotten and the next connect pairs.
				await forget(url, directory, machine);
				// A stored token refused at the start pairs again at once on a terminal, as if none were
				// stored. A service stops rather than wait on a browser, and a machine disconnected while
				// it was connected stays stopped.
				if (!stored || announced || !process.stdin.isTTY || !process.stdout.isTTY) throw error;
				output.say("This machine needs pairing with Chopin again.");
			} finally {
				planners.abort();
				await planning;
			}
		}
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		unwatch();
		await release();
	}
	if (install) {
		await installCommand({
			host: injected.host,
			executable,
			check: !parsed.flags.has("skip-check"),
		});
	}
}

const NOT_INSTALLED = "chopin service install needs the installed chopin, not connector.js. "
	+ "Install it with install.sh or install.ps1 (see docs/local-experiments.md), then run it from "
	+ "there.";

/** This chopin's path when it is the installed binary, which the service runs. */
function installedChopin() {
	return Bun.isStandaloneExecutable ? process.execPath : undefined;
}

/** `chopin service install`, which `connect --install-service` also runs once connected. */
async function installCommand(options: {
	allowDowngrade?: boolean;
	/** Whether to start the agent once, as the service would, before installing. */
	check?: boolean;
	host?: ServiceHost | undefined;
	executable?: string | undefined;
}) {
	let directory = stateDirectory();
	let host = options.host ?? systemHost();
	let output = createOutput();
	if (!options.executable) throw new ServiceError(NOT_INSTALLED);
	let saved = (await readConfig(directory)).connect;
	if (!saved?.server) throw new ServiceError(CONNECT_FIRST);
	let url = saved.server;
	if (process.env.CHOPIN_URL && origin(process.env.CHOPIN_URL) !== url) {
		throw new ServiceError(
			`CHOPIN_URL is ${origin(process.env.CHOPIN_URL)}, but chopin connect saved ${url}. `
				+ "Nothing was installed. Run chopin connect again with the server you want, then "
				+ "chopin service install.",
		);
	}
	if (!await machineToken(directory, url)) {
		throw new ServiceError(
			`This machine is not paired with ${url}. Run \`${SELF} pair\` first, then install the `
				+ "service.",
		);
	}
	let installed = await installService(host, { executable: options.executable, directory }, {
		allowDowngrade: !!options.allowDowngrade,
		check: !!options.check,
	});
	output.say(
		`${output.style.green("✓ Installed the chopin service")} (${installed.manager}). `
			+ `It connects ${saved.checkout} to ${url} as chopin connect last did.`,
		output.style.dim(
			"  To change what it runs, run chopin connect again with new arguments, then chopin "
				+ "service install again.",
		),
		output.style.dim(`  Definition: ${installed.definition}`),
		output.style.dim(`  Log: ${installed.log}`),
		...installed.notes.map(note => output.style.dim(`  ${note}`)),
	);
}

const SERVICE_USAGE = `Usage: ${SELF} service install [--allow-downgrade] [--skip-check] | `
	+ `${SELF} service status | restart | uninstall`;

/** `service install|status|restart|uninstall`: run `connect` as this user's background service. */
async function serviceCommand(args: string[]) {
	let [action, ...rest] = args;
	let parsed = parseArgs(
		rest,
		action === "install" ? { flags: ["allow-downgrade", "skip-check"] } : {},
	);
	if (parsed.positional.length || parsed.rest) throw new Error(SERVICE_USAGE);
	let directory = stateDirectory();
	let host = systemHost();
	let output = createOutput();
	let lines = (notes: string[]) => notes.map(note => output.style.dim(`  ${note}`));
	if (action === "install") {
		await installCommand({
			allowDowngrade: parsed.flags.has("allow-downgrade"),
			check: !parsed.flags.has("skip-check"),
			executable: installedChopin(),
		});
		return;
	}
	if (action === "status") {
		let status = await serviceStatus(host, directory);
		output.say(
			`Service: ${status.state} (${status.manager}${status.pid ? `, pid ${status.pid}` : ""})`,
			output.style.dim(`  Definition: ${status.definition}`),
			output.style.dim(`  Log: ${status.log}`),
			...lines(status.notes),
		);
	} else if (action === "restart") {
		let restarted = await restartService(host, directory);
		output.say(`${output.style.green("✓ Restarted the chopin service")} (${restarted.manager}).`);
	} else if (action === "uninstall") {
		let removed = await uninstallService(host, directory);
		output.say(
			removed.removed
				? `${output.style.green("✓ Removed the chopin service")} (${removed.definition}).`
				: "The chopin service is not installed.",
			...lines(removed.notes),
		);
	} else {
		throw new Error(SERVICE_USAGE);
	}
}

const USAGE =
	`Usage: CHOPIN_URL=https://your-instance ${SELF} connect [checkout] [--key <pairing key>] `
	+ "[--planner <document URL>]... [--planner-command <command>] [--env KEY=VALUE]... "
	+ "[--install-service [--skip-check]] -- agent [ACP arguments]";

const HELP = [
	`Usage: ${SELF} <command> [--base-dir <dir>]`,
	"",
	"Commands:",
	"  pair [--label <name>] [--key <pairing key>]",
	"      Pair this machine with Chopin (once) and store its token. Pairing again replaces it.",
	"      --label names the machine in Chopin (default: this computer's hostname).",
	"      --key (or CHOPIN_PAIRING_KEY) pairs at once with a single-use key from Machines → Add a",
	"      machine, with no browser; without one you approve the pairing in a browser.",
	"  unpair",
	"      Revoke this machine's token in Chopin and delete it here.",
	"  connect [checkout] [--key <pairing key>] -- <agent> [ACP arguments]",
	"      Run the work you start in the checkout's documents with a local ACP agent.",
	"      Pairs this machine first if it isn't paired yet, with --key or CHOPIN_PAIRING_KEY as",
	"      pair does. Once connected, saves what it runs for service install (never the key). A",
	"      program this shell finds only through a version manager's per-shell directory is saved",
	"      by its stable path.",
	"      --planner <document URL> (repeatable) with --planner-command <command> also runs that",
	"      command in the checkout as each document's Planner under HARNESS=remote, and starts it",
	"      again whenever it exits. CHOPIN_PLANNER_COMMAND may hold the command as a JSON array.",
	"      --env KEY=VALUE (repeatable) sets a variable for the agent and the Planner. It is saved",
	"      in config.json, so keep secrets in the agent's own login. CHOPIN_* and PATH are refused.",
	"      --install-service connects once, then stops and runs service install, so one command",
	"      sets up the service. --skip-check passes on to it.",
	"  status [--json]",
	"      Show this chopin's version, the server, whether this machine is paired and Chopin",
	"      still accepts it, the connectors running here and the Planners they run, an agent or",
	"      Planner that keeps failing to start, the service, what it runs, and the log path.",
	"  service install [--allow-downgrade] [--skip-check]",
	"      Run what connect last ran as this user's background service (systemd, launchd or Task",
	"      Scheduler), so it starts again after a reboot and outlives your login session. Later",
	"      connects don't change it; to change what it runs, run connect again with new",
	"      arguments, then service install again. First it starts the agent as the service",
	"      would and refuses one that doesn't answer within 10 seconds; --skip-check skips that",
	"      for an agent that can't start without a terminal. A service a newer chopin installed",
	"      is kept unless --allow-downgrade.",
	"  service status | restart | uninstall",
	"      Show whether it is running, stopped, restart-pending or not-installed; restart it;",
	"      or stop and remove it, keeping the pairing, config and runs.",
	"  update [version] [--allow-downgrade] [--yes]",
	"      Replace this chopin with a verified release: by default the one your Chopin instance",
	"      recommends, or else the newest. An older release needs --allow-downgrade; --yes skips",
	"      the question asked on a terminal. A running service on this chopin restarts.",
	"  version    Print the CLI version.",
	"  help       Show this help.",
	"",
	"--base-dir (or CHOPIN_HOME) is where the machine token, locks and worktrees live",
	"(default ~/.local/state/chopin/connector).",
	"CHOPIN_URL names your Chopin instance for connect, which saves it for the other commands",
	`and the service (default: ${DEFAULT_URL}).`,
].join("\n");

if (import.meta.main) {
	let [mode, ...args] = process.argv.slice(2);
	await removeReplaced();
	try {
		if (mode === "bridge") await bridge();
		else if (mode === "update") {
			let parsed = parseArgs(args, { flags: ["allow-downgrade", "yes"] });
			if (parsed.positional.length > 1 || parsed.rest) {
				throw new Error(`Usage: ${SELF} update [version] [--allow-downgrade] [--yes]`);
			}
			await update({
				version: parsed.positional[0],
				allowDowngrade: parsed.flags.has("allow-downgrade"),
				yes: parsed.flags.has("yes"),
				server: await server(),
				afterUpdate: target => restartAfterUpdate(systemHost(), stateDirectory(), target),
			});
		} else if (mode === "connect") await connect(args);
		else if (mode === "service") await serviceCommand(args);
		else if (mode === "status") await statusCommand(args);
		else if (mode === "pair") await pairCommand(args);
		else if (mode === "unpair") await unpairCommand(args);
		else if (mode === "version" || mode === "--version" || mode === "-v") {
			console.log(`chopin ${VERSION}`);
		} else if (mode === "help" || mode === "--help" || mode === "-h") console.log(HELP);
		else throw new Error(mode ? `Unknown command: ${mode}\n\n${HELP}` : HELP);
	} catch (error) {
		if (!(error instanceof Error && error.name === "AbortError")) {
			createOutput().error(
				connectorMessage(error) ?? (error instanceof Error ? error.message : "Connector failed"),
			);
			process.exitCode = 1;
		}
	}
}
