import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConnectorStopped, serveWork } from "./connection";
import { remote } from "./mcp";
import { parseArgs } from "./args";
import { connectorMessage, forget, machineToken, pair, register, SELF, unpair } from "./machine";
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
	restartAfterUpdate,
	restartService,
	ServiceError,
	serviceStatus,
	systemHost,
	uninstallService,
} from "./service";
import { collectStatus, formatStatus, type ServerSource } from "./status";
import { removeReplaced, update } from "./update";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
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

/** `pair [--label <name>]`: pair this machine and store its token, replacing any earlier one. */
async function pairCommand(args: string[]) {
	let parsed = parseArgs(args, { options: ["label"] });
	if (parsed.positional.length || parsed.rest) {
		throw new Error(`Usage: ${SELF} pair [--label <name>]`);
	}
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

async function connect(args: string[]) {
	// `--service` marks the connector the installed service runs, which runs what install copied.
	let parsed = parseArgs(args, {
		flags: ["service"],
		options: ["planner-command"],
		lists: ["planner"],
	});
	let service = parsed.flags.has("service");
	let directory = stateDirectory();
	let saved = service ? (await readConfig(directory)).service?.settings : undefined;
	if (
		service
		&& (parsed.positional.length || parsed.rest || parsed.lists.size
			|| parsed.options.has("planner-command"))
	) {
		throw new Error(
			`${SELF} connect --service takes no other arguments; it runs what ${SELF} service install saved.`,
		);
	}
	if (service && !saved) throw new Error(CONNECT_FIRST);
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
	if (service && process.platform === "win32") appendOutput(logPath("win32", directory));
	let url = saved?.server ?? await server();
	let info = await workspace(resolve(saved?.checkout ?? parsed.positional[0] ?? "."));
	// The service runs what a terminal's connect saves. A relative agent path would resolve
	// against the service's own working directory.
	let agent = command[0]!;
	let save = () =>
		updateConfig(directory, value => {
			value.connect = {
				server: url,
				checkout: info.root,
				command: !isAbsolute(agent) && (agent.includes("/") || agent.includes(sep))
					? [resolve(agent), ...command.slice(1)]
					: command,
				planners: plannerDocuments,
				plannerCommand,
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
			let machine = stored
				?? await pair({
					url,
					label: hostname(),
					directory,
					output,
					signal: abort.signal,
					checkout: source,
				});
			if (!machine) return;
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
						}),
				});
				return;
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
}

const SERVICE_USAGE = `Usage: ${SELF} service install [--allow-downgrade] | `
	+ `${SELF} service status | restart | uninstall`;

/** `service install|status|restart|uninstall`: run `connect` as this user's background service. */
async function serviceCommand(args: string[]) {
	let [action, ...rest] = args;
	let parsed = parseArgs(rest, action === "install" ? { flags: ["allow-downgrade"] } : {});
	if (parsed.positional.length || parsed.rest) throw new Error(SERVICE_USAGE);
	let directory = stateDirectory();
	let host = systemHost();
	let output = createOutput();
	let lines = (notes: string[]) => notes.map(note => output.style.dim(`  ${note}`));
	if (action === "install") {
		if (!Bun.isStandaloneExecutable) {
			throw new ServiceError(
				"chopin service install needs the installed chopin, not connector.js. Install it with "
					+ "install.sh or install.ps1 (see docs/local-experiments.md), then run it from there.",
			);
		}
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
		let installed = await installService(host, { executable: process.execPath, directory }, {
			allowDowngrade: parsed.flags.has("allow-downgrade"),
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
			...lines(installed.notes),
		);
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

const USAGE = `Usage: CHOPIN_URL=https://your-instance ${SELF} connect [checkout] `
	+ "[--planner <document URL>]... [--planner-command <command>] -- agent [ACP arguments]";

const HELP = [
	`Usage: ${SELF} <command> [--base-dir <dir>]`,
	"",
	"Commands:",
	"  pair [--label <name>]",
	"      Pair this machine with Chopin (once) and store its token. Pairing again replaces it.",
	"      --label names the machine in Chopin (default: this computer's hostname).",
	"  unpair",
	"      Revoke this machine's token in Chopin and delete it here.",
	"  connect [checkout] -- <agent> [ACP arguments]",
	"      Run the work you start in the checkout's documents with a local ACP agent.",
	"      Pairs this machine first if it isn't paired yet. Once connected, saves what it runs",
	"      for service install.",
	"      --planner <document URL> (repeatable) with --planner-command <command> also runs that",
	"      command in the checkout as each document's Planner under HARNESS=remote, and starts it",
	"      again whenever it exits. CHOPIN_PLANNER_COMMAND may hold the command as a JSON array.",
	"  status [--json]",
	"      Show this chopin's version, the server, whether this machine is paired and Chopin",
	"      still accepts it, the connectors running here and the Planners they run, the service,",
	"      what it runs, and the log path.",
	"  service install [--allow-downgrade]",
	"      Run what connect last ran as this user's background service (systemd, launchd or Task",
	"      Scheduler), so it starts again after a reboot. Later connects don't change it; to",
	"      change what it runs, run connect again with new arguments, then service install again.",
	"      A service a newer chopin installed is kept unless --allow-downgrade.",
	"  service status | restart | uninstall",
	"      Show whether it is running, stopped, restart-pending or not-installed; restart it;",
	"      or stop and remove it, keeping the pairing, config and runs.",
	"  update [version] [--allow-downgrade] [--yes]",
	"      Replace this chopin with a verified release: by default the one your Chopin instance",
	"      recommends, or else the newest. An older release needs --allow-downgrade; --yes skips",
	"      the question asked on a terminal. A running service on this chopin restarts.",
	"  version    Print the CLI version and the connector protocol it speaks.",
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
			console.log(`chopin ${VERSION} (connector protocol ${CONNECTOR_PROTOCOL})`);
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
