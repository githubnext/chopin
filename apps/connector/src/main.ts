import { basename, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requestSchema } from "@chopin/experiment";
import { createBridge } from "./bridge";
import { ConnectorError, remote } from "./mcp";
import { runWork } from "./run";
import { implementationBridge } from "./implementation";
import { lockWorkspace, stateDirectory, workspace } from "./workspace";

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
		server = await implementationBridge(api);
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

async function connect(args: string[]) {
	let split = args.indexOf("--");
	let command = split >= 0
		? args.slice(split + 1)
		: JSON.parse(process.env.CHOPIN_ACP_COMMAND ?? "[]");
	if (
		!Array.isArray(command) || !command.length
		|| command.some(item => typeof item !== "string" || !item)
	) {
		throw new Error(
			"Usage: CHOPIN_URL=https://your-instance chopin connect [checkout] -- agent acp-arguments",
		);
	}
	let url = origin(process.env.CHOPIN_URL ?? "https://chopin.githubnext.com");
	let info = await workspace(resolve(args[0] && args[0] !== "--" ? args[0] : "."));
	let directory = stateDirectory();
	let release = await lockWorkspace(info.root, directory);
	let abort = new AbortController();
	let stop = () => abort.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	async function post(path: string, body: unknown) {
		let response = await fetch(url + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: abort.signal,
		});
		let value = await response.json();
		if (!response.ok) throw new Error(value.error ?? "Connector request failed");
		return value;
	}
	let api: Awaited<ReturnType<typeof remote>> | undefined;
	try {
		let { root: _root, ...source } = info;
		let pairing = await post("/api/connector/pairings", { ...source, label: basename(info.root) });
		console.error(`Connect this checkout of ${info.repository} in Chopin: ${pairing.url}`);
		console.error(`Confirm code ${pairing.code} in Chopin.`);
		let token: string | undefined;
		while (!abort.signal.aborted && !token) {
			let claim = await post(`/api/connector/pairings/${pairing.id}/claim`, {
				secret: pairing.secret,
			});
			token = claim.token;
			if (!token) await delay(1000, abort.signal);
		}
		if (!token) return;
		api = await remote(url, token);
		console.error(
			`Connected. Work you start in any ${info.repository} document runs here. Ctrl-C disconnects.`,
		);
		while (!abort.signal.aborted) {
			let offered = await api.call("wait_for_work", {}, abort.signal) as {
				id?: string;
				kind?: "experiment" | "implementation";
			};
			if (!offered.id || !offered.kind) continue;
			let claim;
			try {
				claim = await api.call(
					offered.kind === "implementation" ? "claim_implementation_build" : "claim_experiment",
					{ id: offered.id },
				);
			} catch (error) {
				if (
					error instanceof ConnectorError
					&& ["workspace-busy", "build-already-claimed", "invalid-state"].includes(error.code)
				) {
					await delay(1000, abort.signal);
					continue;
				}
				throw error;
			}
			await runWork(api, offered.kind, claim, {
				root: info.root,
				directory,
				command,
				url,
				script: resolve(process.argv[1]),
				signal: abort.signal,
			});
		}
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		if (api) {
			await api.call("disconnect_workspace").catch(() => {});
			await api.close();
		}
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await release();
	}
}

function delay(ms: number, signal: AbortSignal) {
	return new Promise<void>(resolve => {
		let finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		let timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

if (import.meta.main) {
	let [mode, ...args] = process.argv.slice(2);
	try {
		if (mode === "bridge") await bridge();
		else if (mode === "connect") await connect(args);
		else throw new Error("Usage: chopin connect [checkout] -- agent [ACP arguments]");
	} catch (error) {
		if (!(error instanceof Error && error.name === "AbortError")) {
			console.error(error instanceof Error ? error.message : "Connector failed");
			process.exitCode = 1;
		}
	}
}
