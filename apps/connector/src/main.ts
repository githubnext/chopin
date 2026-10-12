import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requestSchema } from "@chopin/experiment";
import { createBridge } from "./bridge";
import { serveWork } from "./connection";
import { remote } from "./mcp";
import { parseArgs } from "./args";
import { connectorMessage, machineToken, pair, register, SELF, unpair } from "./machine";
import { createOutput } from "./output";
import { permissionMemory } from "./permission";
import { runWork } from "./run";
import { implementationBridge } from "./implementation";
import { removeReplaced, update } from "./update";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { lockWorkspace, stateDirectory, workspace } from "./workspace";

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
	let server;
	// A spike's tools are the server's run-scoped list, relayed as they are.
	if (["implementation", "spike"].includes(process.env.CHOPIN_BRIDGE_KIND ?? "")) {
		server = await implementationBridge(api, process.env.CHOPIN_BRIDGE_ROOT);
	} else {
		let context = await api.call("read_experiment") as { input: unknown };
		server = createBridge(requestSchema.parse(context.input), async result => {
			await api.call("submit_experiment_result", { result });
		});
	}
	await server.connect(new StdioServerTransport());
	let close = async () => {
		await server.close();
		await api.close();
	};
	process.once("SIGTERM", () => void close());
	process.once("SIGINT", () => void close());
}

function server() {
	return origin(process.env.CHOPIN_URL ?? DEFAULT_URL);
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
			url: server(),
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
	let url = server();
	let result = await unpair(url, stateDirectory());
	createOutput().say(
		result === "unpaired"
			? `Unpaired this machine from ${url}.`
			: `This machine is not paired with ${url}.`,
	);
}

async function connect(args: string[]) {
	let parsed = parseArgs(args);
	let command = parsed.rest ?? JSON.parse(process.env.CHOPIN_ACP_COMMAND ?? "[]");
	if (
		!Array.isArray(command) || !command.length
		|| command.some(item => typeof item !== "string" || !item)
	) {
		throw new Error(USAGE);
	}
	let url = server();
	let info = await workspace(resolve(parsed.positional[0] ?? "."));
	let directory = stateDirectory();
	let release = await lockWorkspace(info.root, directory);
	let abort = new AbortController();
	// The first Ctrl-C reports running work as stopped, then disconnects; a second forces exit.
	let stop = () => {
		if (abort.signal.aborted) process.exit(130);
		abort.abort();
		process.once("SIGINT", () => process.exit(130));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let output = createOutput();
	let permissions = permissionMemory();
	try {
		let { root: _root, ...source } = info;
		// A machine paired once reconnects with its stored token; an unpaired one pairs first.
		let machine = await machineToken(directory, url)
			?? await pair({
				url,
				label: hostname(),
				directory,
				output,
				signal: abort.signal,
				checkout: source,
			});
		if (!machine) return;
		let checkout = { ...source, label: basename(info.root) };
		let announced = false;
		await serveWork({
			// Every connection registers anew with the machine token: a connection token lasts only
			// while the server runs, so after a restart Chopin refuses the old one for good.
			connect: async () => {
				let api = await remote(url, await register(url, machine, checkout));
				if (!announced) output.connected(info.repository);
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
				}),
		});
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await release();
	}
}

const USAGE = `Usage: CHOPIN_URL=https://your-instance ${SELF} connect [checkout] -- `
	+ "agent [ACP arguments]";

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
	"      Pairs this machine first if it isn't paired yet.",
	"  update [version] [--allow-downgrade] [--yes]",
	"      Replace this chopin with a verified release: by default the one your Chopin instance",
	"      recommends, or else the newest. An older release needs --allow-downgrade; --yes skips",
	"      the question asked on a terminal.",
	"  version    Print the CLI version and the connector protocol it speaks.",
	"  help       Show this help.",
	"",
	"--base-dir (or CHOPIN_HOME) is where the machine token, locks and worktrees live",
	"(default ~/.local/state/chopin/connector).",
	`CHOPIN_URL names your Chopin instance (default ${DEFAULT_URL}).`,
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
				server: server(),
			});
		} else if (mode === "connect") await connect(args);
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
