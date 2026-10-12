import { createInterface } from "node:readline/promises";
import { requestSchema } from "@chopin/experiment";
import type { BuildRequest } from "@chopin/protocol/implementation";
import { remote } from "./mcp";
import { runAgent } from "./acp";
import { serveLocalBridge } from "./local-bridge";
import { createOutput } from "./output";
import type { Output } from "./output";
import { describePermission, permissionMemory } from "./permission";
import { discardWorkspace, git, noPushEnvironment, prepareWorkspace } from "./workspace";
import {
	implementationPrompt,
	liveImplementationPrompt,
	rebuildPrompt,
	relay,
} from "./implementation";

type Options = {
	root: string;
	directory: string;
	command: string[];
	url: string;
	script: string;
	signal: AbortSignal;
	heartbeatMs?: number;
	output?: Output;
	/** Shared across jobs so an "always allow" lasts for the connector's run. */
	permissions?: ReturnType<typeof permissionMemory>;
};
export async function runWork(
	api: Awaited<ReturnType<typeof remote>>,
	kind: "experiment" | "implementation",
	raw: unknown,
	options: Options,
) {
	let implementation = kind === "implementation";
	let claim = raw as {
		build: BuildRequest;
		/** A living document's first build, whose run ends at its last complete_task. */
		live?: boolean;
		/** An unprompted prototype under a passage, run on a throwaway branch. */
		spike?: boolean;
		/** The document's title, for the terminal. */
		title?: string;
		input: unknown;
		generation: number;
		runToken: string;
	};
	let rebuild = implementation && claim.build.kind === "rebuild";
	let input = implementation
		? {
			id: claim.build.id,
			source: { ...claim.build.checkout, repositoryId: claim.build.repositoryId },
		}
		: requestSchema.parse(claim.input);
	let output = options.output ?? createOutput();
	let permissions = options.permissions ?? permissionMemory();
	// Kept so a failed start can show why without echoing every agent log line.
	let agentTail: string[] = [];
	let identity = implementation ? { id: input.id } : { id: input.id, generation: claim.generation };
	let abort = new AbortController();
	let cancel = () => abort.abort();
	options.signal.addEventListener("abort", cancel, { once: true });
	if (options.signal.aborted) abort.abort();
	let latestProgress = "Preparing checkout";
	let renewing = false;
	let heartbeat = setInterval(() => {
		if (renewing) return;
		renewing = true;
		void api.call(implementation ? "renew_implementation_build" : "renew_experiment", {
			...identity,
			...(!implementation ? { progress: latestProgress } : {}),
		}).then(result => {
			// A rebuild stops once its report lands; the agent may still be finishing its turn.
			if ((result as { state?: string } | undefined)?.state === "stopped") clearInterval(heartbeat);
		}).catch(() => abort.abort()).finally(() => renewing = false);
	}, options.heartbeatMs ?? 10_000);
	let local: ReturnType<typeof serveLocalBridge> | undefined;
	/** A spike's throwaway worktree and branch, removed when the run ends. */
	let spikeWork: { path: string; branch: string } | undefined;
	let bridgeApi: Promise<Awaited<ReturnType<typeof remote>>> | undefined;
	try {
		let prepared = await prepareWorkspace(options.root, options.directory, input);
		// A rebuild commits onto the existing pull request branches the agent checks out itself.
		if (implementation && !rebuild) {
			git(prepared.path, "checkout", "-b", `chopin/implement-${input.id.slice(0, 8)}`);
		}
		if (claim.spike) {
			spikeWork = { path: prepared.path, branch: `chopin/spike-${input.id.slice(0, 8)}` };
			git(prepared.path, "checkout", "-b", spikeWork.branch);
		}
		output.job(
			implementation ? "build" : claim.spike ? "spike" : "investigation",
			implementation ? claim.title ?? input.id : (input as { brief: string }).brief,
			prepared.path,
		);
		let stop = await runAgent({
			command: options.command,
			cwd: prepared.path,
			...(claim.spike ? { env: noPushEnvironment() } : {}),
			prompt: rebuild
				? rebuildPrompt
				: implementation
				? claim.live ? liveImplementationPrompt : implementationPrompt
				: claim.spike
				? "Use read_investigation from the Chopin MCP server to read the spike brief and "
					+ "follow it: build the smallest prototype on this throwaway branch, take 1-3 "
					+ "1280x800 PNG screenshots of the running prototype with Playwright, save them in "
					+ "this worktree, upload each with upload_image_file({path}), and report with "
					+ "submit_spike_result, then finish. Never push."
				: "Use read_investigation from the Chopin MCP server to read the authorized request. "
					+ "Perform that investigation using your normal project instructions and tools. "
					+ "Submit a bounded result with submit_investigation_result, then finish. "
					+ "Do not commit or push unless the authorized brief specifically requests it.",
			// A spike needs the connector-local upload_image_file, so its tools come from this process:
			// a loopback HTTP bridge when the agent accepts HTTP servers, the stdio bridge otherwise.
			mcpServers(http) {
				let name = implementation ? "chopin-implementation" : "chopin-investigation";
				if (http && claim.spike) {
					let tools: ReturnType<typeof relay> | undefined;
					local = serveLocalBridge(() => {
						tools ??= (bridgeApi ??= remote(options.url, claim.runToken))
							.then(api => relay(api, prepared.path))
							.catch(error => {
								tools = bridgeApi = undefined;
								throw error;
							});
						return tools.then(make => make());
					});
					return [{
						name,
						type: "http",
						url: local.url,
						headers: [{ name: "Authorization", value: `Bearer ${local.token}` }],
					}];
				}
				if (http) {
					return [{
						name,
						type: "http",
						url: options.url + "/connector/mcp",
						headers: [{ name: "Authorization", value: `Bearer ${claim.runToken}` }],
					}];
				}
				return [{
					name,
					command: process.execPath,
					args: [options.script, "bridge"],
					env: [
						{ name: "CHOPIN_BRIDGE_ORIGIN", value: options.url },
						{ name: "CHOPIN_BRIDGE_TOKEN", value: claim.runToken },
						{ name: "CHOPIN_BRIDGE_KIND", value: claim.spike ? "spike" : kind },
						...(claim.spike ? [{ name: "CHOPIN_BRIDGE_ROOT", value: prepared.path }] : []),
					],
				}];
			},
			signal: abort.signal,
			onSession: implementation
				? session =>
					api.call("report_implementation_build", {
						...identity,
						state: "running",
						session,
					}).then(() => {})
				: undefined,
			onUpdate(value) {
				if (value.update.sessionUpdate === "tool_call") {
					latestProgress = value.update.title.slice(0, 2000);
				}
			},
			async permission(request) {
				let remembered = permissions.remembered(request);
				if (remembered) return remembered;
				latestProgress = "Waiting for permission in the owner's terminal";
				if (!process.stdin.isTTY) return undefined;
				let terminal = createInterface({ input: process.stdin, output: process.stdout });
				try {
					let [heading, ...detail] = describePermission(request);
					output.say(
						"",
						`  ${output.style.bold(`Allow ${heading}?`)}`,
						...detail.map(line => `    ${line}`),
						...request.options.map((option, index) => `  ${index + 1}. ${option.name}`),
					);
					let answer = await terminal.question("  Select option (blank cancels): ", {
						signal: abort.signal,
					});
					let chosen = request.options[Number(answer) - 1]?.optionId;
					permissions.chose(request, chosen);
					return chosen;
				} finally {
					terminal.close();
				}
			},
			stderr(text) {
				agentTail = [...agentTail, ...text.split("\n").filter(Boolean)].slice(-10);
				output.agent(text);
			},
		});
		if (stop !== "end_turn" || abort.signal.aborted) throw new Error(`Agent stopped: ${stop}`);
		await api.call(implementation ? "report_implementation_build" : "complete_experiment", {
			...identity,
			...(implementation ? { state: "stopped" } : {}),
		});
		output.finished();
	} catch (error) {
		let message = error instanceof Error ? error.message : "Local work failed";
		output.failed(message, agentTail);
		await api.call(implementation ? "report_implementation_build" : "fail_experiment", {
			...identity,
			...(implementation ? { state: "failed" } : {}),
			error: implementation
				? "Local implementation failed. Inspect the connector terminal."
				: message.slice(0, 2000),
		}).catch(() => {});
	} finally {
		local?.close();
		await bridgeApi?.then(api => api.close()).catch(() => {});
		if (spikeWork) {
			await discardWorkspace(options.root, spikeWork.path, spikeWork.branch).catch(() => {});
		}
		clearInterval(heartbeat);
		options.signal.removeEventListener("abort", cancel);
	}
}
