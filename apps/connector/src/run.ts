import { requestSchema } from "@chopin/experiment";
import type { BuildRequest } from "@chopin/protocol/implementation";
import { remote } from "./mcp";
import { ConnectorStopped } from "./connection";
import { errorCode } from "./machine";
import { backoff, delay, forgottenMessage, RUN_GRACE_MS, runReports } from "./reconnect";
import { bridgeCommand } from "./bridge";
import { runAgent } from "./acp";
import { serveLocalBridge } from "./local-bridge";
import { createOutput } from "./output";
import type { Output } from "./output";
import { ask, describePermission, permissionMemory } from "./permission";
import { stopProcessesIn } from "./processes";
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
	signal: AbortSignal;
	heartbeatMs?: number;
	output?: Output;
	/** Ctrl-C at a permission prompt; it stops the connector as Ctrl-C anywhere else does. */
	interrupt?: () => void;
	/** Shared across jobs so an "always allow" lasts for the connector's run. */
	permissions?: ReturnType<typeof permissionMemory>;
	/** How long the agent keeps running while Chopin is out of reach; ten minutes by default. */
	graceMs?: number;
	/**
	 * How long the agent keeps running while Chopin refuses only as a server that forgot this
	 * connection does; two minutes by default. The connector then stops, as pairing is needed.
	 */
	forgetMs?: number;
	/** The jitter source for retries, for tests. */
	random?: () => number;
};
export const STOPPED = "Stopped from the connector terminal.";

function minutes(ms: number) {
	let value = Math.round(ms / 60_000);
	return value >= 1
		? `${value} minute${value === 1 ? "" : "s"}`
		: `${Math.round(ms / 1000)} seconds`;
}

export async function runWork(
	api: Pick<Awaited<ReturnType<typeof remote>>, "call">,
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
	/** Why the connector stopped the agent itself, when Chopin ended the run or stayed out of reach. */
	let ended: string | undefined;
	/** Chopin forgot this connection, so the connector must stop once the run has reported. */
	let forgotten = false;
	// Each build report carries its own idempotencyKey, kept across its retries, so Chopin accepts a
	// report again whose answer was lost instead of refusing it as a second transition.
	let reports = runReports(api, {
		stop: options.signal,
		graceMs: options.graceMs,
		forgetMs: options.forgetMs,
		random: options.random,
		lost: () => output.offline(),
		back: () => output.online(),
		expired(reason) {
			forgotten = reason === "forgotten";
			ended ??= forgotten
				? forgottenMessage()
				: `Chopin was out of reach for ${minutes(options.graceMs ?? RUN_GRACE_MS)}.`;
			abort.abort();
		},
	});
	// A heartbeat that fails while Chopin is out of reach retries on the reconnect backoff and
	// leaves the agent running; only Chopin ending the run, or the grace period, stops it.
	let beating = new AbortController();
	// Ctrl-C, the run ending and the grace period running out each abandon a heartbeat in flight.
	let beat = AbortSignal.any([beating.signal, options.signal, reports.signal]);
	let heartbeat = (async () => {
		let failures = 0;
		while (!beat.aborted) {
			await delay(
				failures
					? Math.min(backoff(failures - 1, options.random), reports.remaining())
					: options.heartbeatMs ?? 10_000,
				beat,
			);
			if (beat.aborted) return;
			try {
				let result = await reports.attempt(
					implementation ? "renew_implementation_build" : "renew_experiment",
					{ ...identity, ...(!implementation ? { progress: latestProgress } : {}) },
					beat,
				);
				failures = 0;
				// A rebuild stops once its report lands; the agent may still be finishing its turn.
				if ((result as { state?: string } | undefined)?.state === "stopped") return;
			} catch (error) {
				// Ended from here: the run is over, or the grace period stopped the agent.
				if (beat.aborted) return;
				if (reports.retryable(error)) {
					failures++;
					continue;
				}
				ended ??= `Chopin ended this run (${errorCode(error) ?? "refused"}).`;
				abort.abort();
				return;
			}
		}
	})();
	let local: ReturnType<typeof serveLocalBridge> | undefined;
	/** A spike's throwaway worktree and branch, removed when the run ends. */
	let spikeWork: { path: string; branch: string } | undefined;
	let bridgeApi: Promise<Awaited<ReturnType<typeof remote>>> | undefined;
	let prepared: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
	try {
		prepared = await prepareWorkspace(options.root, options.directory, input);
		let path = prepared.path;
		// A rebuild commits onto the existing pull request branches the agent checks out itself.
		if (implementation && !rebuild) {
			git(path, "checkout", "-b", `chopin/implement-${input.id.slice(0, 8)}`);
		}
		if (claim.spike) {
			spikeWork = { path, branch: `chopin/spike-${input.id.slice(0, 8)}` };
			git(path, "checkout", "-b", spikeWork.branch);
		}
		output.job(
			implementation ? "build" : claim.spike ? "spike" : "investigation",
			implementation ? claim.title ?? input.id : (input as { brief: string }).brief,
			path,
		);
		let stop = await runAgent({
			command: options.command,
			cwd: path,
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
							.then(api => relay(api, path))
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
					...bridgeCommand(),
					env: [
						{ name: "CHOPIN_BRIDGE_ORIGIN", value: options.url },
						{ name: "CHOPIN_BRIDGE_TOKEN", value: claim.runToken },
						{ name: "CHOPIN_BRIDGE_KIND", value: claim.spike ? "spike" : kind },
						...(claim.spike ? [{ name: "CHOPIN_BRIDGE_ROOT", value: path }] : []),
					],
				}];
			},
			signal: abort.signal,
			onSession: implementation
				? session =>
					reports.deliver("report_implementation_build", {
						...identity,
						state: "running",
						session,
						idempotencyKey: crypto.randomUUID(),
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
				let [heading, ...detail] = describePermission(request);
				output.say(
					"",
					`  ${output.style.bold(`Allow ${heading}?`)}`,
					...detail.map(line => `    ${line}`),
					...request.options.map((option, index) => `  ${index + 1}. ${option.name}`),
				);
				let answer = await ask("  Select option (blank cancels): ", {
					input: process.stdin,
					output: process.stdout,
					signal: abort.signal,
					interrupt: options.interrupt ?? (() => abort.abort()),
				});
				let chosen = request.options[Number(answer) - 1]?.optionId;
				permissions.chose(request, chosen);
				return chosen;
			},
			stderr(text) {
				agentTail = [...agentTail, ...text.split("\n").filter(Boolean)].slice(-10);
				output.agent(text);
			},
		});
		if (stop !== "end_turn" || abort.signal.aborted) throw new Error(`Agent stopped: ${stop}`);
		await reports.deliver(implementation ? "report_implementation_build" : "complete_experiment", {
			...identity,
			...(implementation ? { state: "stopped", idempotencyKey: crypto.randomUUID() } : {}),
		});
		output.finished();
	} catch (error) {
		// Ctrl-C reports why before the connector disconnects, so Chopin knows at once.
		let stopped = options.signal.aborted;
		let message = stopped
			? STOPPED
			: ended
			? ended
			: error instanceof Error
			? error.message
			: "Local work failed";
		if (stopped) output.stopped();
		else output.failed(message, agentTail);
		// After Ctrl-C, or out of reach for the whole grace period, the failure gets one bounded attempt.
		let send = stopped || reports.expired() ? reports.final : reports.deliver;
		await send(implementation ? "report_implementation_build" : "fail_experiment", {
			...identity,
			...(implementation ? { state: "failed", idempotencyKey: crypto.randomUUID() } : {}),
			error: stopped || ended || !implementation
				? message.slice(0, 2000)
				: "Local implementation failed. Inspect the connector terminal.",
		}).catch(() => {});
		// Retrying cannot reach a server that forgot this connection, so the connector stops too.
		if (forgotten && !stopped) throw new ConnectorStopped("forgotten", message);
	} finally {
		// Servers the agent started (often in their own process group) end with its run.
		if (prepared) await stopProcessesIn(prepared.path).catch(() => {});
		local?.close();
		await bridgeApi?.then(api => api.close()).catch(() => {});
		if (spikeWork) {
			await discardWorkspace(options.root, spikeWork.path, spikeWork.branch).catch(() => {});
		}
		beating.abort();
		await heartbeat;
		reports.close();
		options.signal.removeEventListener("abort", cancel);
	}
}
