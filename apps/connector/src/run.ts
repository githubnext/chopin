import { createInterface } from "node:readline/promises";
import { requestSchema } from "@chopin/experiment";
import type { BuildRequest } from "@chopin/protocol/implementation";
import type { remote } from "./mcp";
import { runAgent } from "./acp";
import { git, prepareWorkspace } from "./workspace";
import { implementationPrompt, liveImplementationPrompt, rebuildPrompt } from "./implementation";

type Options = {
	root: string;
	directory: string;
	command: string[];
	url: string;
	script: string;
	signal: AbortSignal;
	heartbeatMs?: number;
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
	try {
		let prepared = await prepareWorkspace(options.root, options.directory, input);
		// A rebuild commits onto the existing pull request branches the agent checks out itself.
		if (implementation && !rebuild) {
			git(prepared.path, "checkout", "-b", `chopin/implement-${input.id.slice(0, 8)}`);
		}
		if (claim.spike) git(prepared.path, "checkout", "-b", `chopin/spike-${input.id.slice(0, 8)}`);
		console.error(`Running ${input.id} in ${prepared.path}`);
		let stop = await runAgent({
			command: options.command,
			cwd: prepared.path,
			prompt: rebuild
				? rebuildPrompt
				: implementation
				? claim.live ? liveImplementationPrompt : implementationPrompt
				: claim.spike
				? "Use read_investigation from the Chopin MCP server to read the spike brief and "
					+ "follow it: build the smallest prototype on this throwaway branch, upload 1-3 "
					+ "screenshots with upload_investigation_image, and report with submit_spike_result, "
					+ "then finish. Never push."
				: "Use read_investigation from the Chopin MCP server to read the authorized request. "
					+ "Perform that investigation using your normal project instructions and tools. "
					+ "Submit a bounded result with submit_investigation_result, then finish. "
					+ "Do not commit or push unless the authorized brief specifically requests it.",
			mcpServers: http =>
				http
					? [{
						name: implementation ? "chopin-implementation" : "chopin-investigation",
						type: "http",
						url: options.url + "/connector/mcp",
						headers: [{ name: "Authorization", value: `Bearer ${claim.runToken}` }],
					}]
					: [{
						name: implementation ? "chopin-implementation" : "chopin-investigation",
						command: process.execPath,
						args: [options.script, "bridge"],
						env: [
							{ name: "CHOPIN_BRIDGE_ORIGIN", value: options.url },
							{ name: "CHOPIN_BRIDGE_TOKEN", value: claim.runToken },
							{ name: "CHOPIN_BRIDGE_KIND", value: claim.spike ? "spike" : kind },
						],
					}],
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
				latestProgress = "Waiting for permission in the owner's terminal";
				if (!process.stdin.isTTY) return undefined;
				let terminal = createInterface({ input: process.stdin, output: process.stderr });
				try {
					console.error(request.toolCall.title ?? "Agent permission request");
					request.options.forEach((option, index) => console.error(`${index + 1}. ${option.name}`));
					let answer = await terminal.question("Select option (blank cancels): ", {
						signal: abort.signal,
					});
					return request.options[Number(answer) - 1]?.optionId;
				} finally {
					terminal.close();
				}
			},
			stderr: text => process.stderr.write(text),
		});
		if (stop !== "end_turn" || abort.signal.aborted) throw new Error(`Agent stopped: ${stop}`);
		await api.call(implementation ? "report_implementation_build" : "complete_experiment", {
			...identity,
			...(implementation ? { state: "stopped" } : {}),
		});
		console.error(`Finished ${input.id}. Workspace retained at ${prepared.path}`);
	} catch (error) {
		let message = error instanceof Error ? error.message : "Local work failed";
		console.error(message);
		await api.call(implementation ? "report_implementation_build" : "fail_experiment", {
			...identity,
			...(implementation ? { state: "failed" } : {}),
			error: implementation
				? "Local implementation failed. Inspect the connector terminal."
				: message.slice(0, 2000),
		}).catch(() => {});
	} finally {
		clearInterval(heartbeat);
		options.signal.removeEventListener("abort", cancel);
	}
}
