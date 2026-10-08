import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { requestSchema } from "@chopin/experiment";
import { createBridge } from "./bridge";
import { remote } from "./mcp";
import { runAgent } from "./acp";
import { lockWorkspace, prepareWorkspace, stateDirectory, workspace } from "./workspace";

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
	let context = await api.call("read_experiment") as { input: unknown };
	let server = createBridge(requestSchema.parse(context.input), async result => {
		await api.call("submit_experiment_result", { result });
	});
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
		console.error(`Approve this workspace in Chopin: ${pairing.url}`);
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
		console.error("Connected. Waiting for owner-authorized investigations. Ctrl-C disconnects.");
		while (!abort.signal.aborted) {
			let offered = await api.call("wait_for_experiment", {}, abort.signal) as { id?: string };
			if (!offered.id) continue;
			let claim = await api.call("claim_experiment", { id: offered.id }) as {
				input: unknown;
				generation: number;
				runToken: string;
			};
			let input = requestSchema.parse(claim.input);
			let runAbort = new AbortController();
			let cancelRun = () => runAbort.abort();
			abort.signal.addEventListener("abort", cancelRun, { once: true });
			let latestProgress = "Preparing checkout";
			let renewal = false;
			let heartbeat = setInterval(() => {
				if (renewal) return;
				renewal = true;
				void api!.call("renew_experiment", {
					id: input.id,
					generation: claim.generation,
					progress: latestProgress,
				})
					.catch(() => runAbort.abort()).finally(() => {
						renewal = false;
					});
			}, 10_000);
			try {
				let prepared = await prepareWorkspace(info.root, directory, input);
				console.error(`Running ${input.id} in ${prepared.path}`);
				let script = resolve(process.argv[1]);
				let stopReason = await runAgent({
					command,
					cwd: prepared.path,
					prompt:
						"Use read_investigation from the Chopin MCP server to read the authorized request. "
						+ "Perform that investigation using your normal project instructions and tools. "
						+ "Submit a bounded result with submit_investigation_result, then finish. "
						+ "Do not commit or push unless the authorized brief specifically requests it.",
					mcpServers: [{
						name: "chopin-investigation",
						command: process.execPath,
						args: [script, "bridge"],
						env: [
							{ name: "CHOPIN_BRIDGE_ORIGIN", value: url },
							{ name: "CHOPIN_BRIDGE_TOKEN", value: claim.runToken },
						],
					}],
					signal: runAbort.signal,
					onUpdate(value) {
						if (value.update.sessionUpdate === "tool_call") {
							latestProgress = value.update.title.slice(0, 2000);
						}
					},
					async permission(request) {
						latestProgress = "Waiting for permission in the owner's terminal";
						if (!process.stdin.isTTY) return undefined;
						let terminal = createInterface({ input: process.stdin, output: process.stderr });
						try {
							console.error(request.toolCall.title ?? "Agent permission request");
							request.options.forEach((option, index) =>
								console.error(`${index + 1}. ${option.name}`)
							);
							let answer = await terminal.question("Select option (blank cancels): ", {
								signal: runAbort.signal,
							});
							return request.options[Number(answer) - 1]?.optionId;
						} finally {
							terminal.close();
						}
					},
					stderr: text => process.stderr.write(text),
				});
				if (stopReason !== "end_turn" || runAbort.signal.aborted) {
					throw new Error(`Agent stopped: ${stopReason}`);
				}
				await api.call("complete_experiment", { id: input.id, generation: claim.generation });
				console.error(`Published ${input.id}. Temporary workspace retained at ${prepared.path}`);
			} catch (error) {
				let message = error instanceof Error ? error.message : "Investigation failed";
				console.error(message);
				await api.call("fail_experiment", {
					id: input.id,
					generation: claim.generation,
					error: message.slice(0, 2000),
				}).catch(() => {});
			} finally {
				clearInterval(heartbeat);
				abort.signal.removeEventListener("abort", cancelRun);
			}
		}
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
		console.error(error instanceof Error ? error.message : "Connector failed");
		process.exitCode = 1;
	}
}
