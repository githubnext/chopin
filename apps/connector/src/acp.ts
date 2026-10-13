import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
	McpServer,
	RequestPermissionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { PROCESSES, stopBackend } from "./planner";
import { VERSION } from "./version";

/** How long a stopped agent's process group has to exit before it is killed. */
const AGENT_STOP = { ...PROCESSES, graceMs: 1000 };

export type AgentOptions = {
	command: string[];
	cwd: string;
	prompt: string;
	mcpServers: McpServer[] | ((http: boolean) => McpServer[]);
	signal: AbortSignal;
	onSession?: (id: string) => Promise<void>;
	onUpdate: (value: SessionNotification) => void;
	permission: (request: RequestPermissionRequest) => Promise<string | undefined>;
	stderr?: (chunk: string) => void;
	/** Added to the agent's environment, such as Git configuration that refuses pushes. */
	env?: Record<string, string>;
	/**
	 * Called once the agent has a session, or with how it ended and the first line of its stderr
	 * when it fails before one.
	 */
	onStart?: (failure?: AgentFailure) => void;
};

/** How an agent that failed to start ended, and the first line of its stderr. */
export type AgentFailure = { how: string; stderr?: string };

/**
 * Start `command` in its own process group and connect `app` to it over ACP. The connection
 * closes when the agent exits. `failure` says how one that failed to start ended, and `stop`
 * stops it and everything it started, resolving once they are gone.
 */
function startAgent(
	app: ClientApp,
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	stderr?: (chunk: string) => void,
) {
	let child = spawn(command[0]!, command.slice(1), {
		cwd,
		...(env ? { env } : {}),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let kill = (signal: NodeJS.Signals = "SIGTERM") => {
		try {
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch { /* Process may have already exited. */ }
	};
	let head = "";
	child.stderr.on("data", chunk => {
		if (head.length < 4096) head += String(chunk);
		stderr?.(String(chunk));
	});
	let ended: string | undefined;
	let exited = new Promise(resolve => {
		child.once("error", error => resolve(ended ??= error.message));
		child.once(
			"exit",
			(code, signal) => resolve(ended ??= signal ? `signal ${signal}` : `exit ${code}`),
		);
	});
	let connection = app.connect(ndJsonStream(
		Writable.toWeb(child.stdin),
		Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
	));
	child.once("error", error => connection.close(error));
	child.once("exit", () => connection.close(new Error("ACP agent exited.")));
	return {
		connection,
		kill,
		async failure(error: unknown): Promise<AgentFailure> {
			// Its exit, and the rest of its stderr, may come just after the failure they caused.
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
			let line = head.split("\n").map(text => text.trim()).find(Boolean);
			return {
				how: ended ?? (error instanceof Error ? error.message : String(error)),
				...(line ? { stderr: line } : {}),
			};
		},
		/**
		 * SIGTERM to its process group, then SIGKILL after a second unless the whole group has
		 * gone, even when the agent itself exited first; on Windows `taskkill /T /F`.
		 */
		async stop() {
			connection.close();
			// On Windows an exited agent's process id may already belong to another process.
			if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) {
				return;
			}
			await stopBackend(child, AGENT_STOP);
		},
	};
}

function initialize(connection: ReturnType<ClientApp["connect"]>) {
	return connection.agent.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		clientInfo: { name: "chopin", version: VERSION },
		clientCapabilities: {},
	});
}

/**
 * Start the agent with `env` as its whole environment and ask it to initialize, then stop it.
 * Undefined once it answers within `timeoutMs`; otherwise how it failed.
 */
export async function checkAgent(
	command: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<AgentFailure | undefined> {
	let timeoutMs = options.timeoutMs ?? 10_000;
	let agent = startAgent(new ClientApp(), command, options.cwd, options.env);
	let deadline = setTimeout(
		() =>
			agent.connection.close(
				new Error(`no answer to ACP initialize within ${timeoutMs / 1000}s`),
			),
		timeoutMs,
	);
	try {
		await initialize(agent.connection);
		return undefined;
	} catch (error) {
		return await agent.failure(error);
	} finally {
		clearTimeout(deadline);
		await agent.stop();
	}
}

/** One protocol implementation; agent-specific launch arguments belong to local configuration. */
export async function runAgent(options: AgentOptions): Promise<string> {
	if (options.signal.aborted) throw new Error("Investigation cancelled.");
	if (!options.command[0]) throw new Error("An ACP command is required.");
	let app = new ClientApp()
		.onNotification("session/update", ({ params }) => options.onUpdate(params))
		.onRequest("session/request_permission", async ({ params: request }) => {
			let id = await options.permission(request);
			return {
				outcome: id && !options.signal.aborted && request.options.some(option =>
						option.optionId === id
					)
					? { outcome: "selected" as const, optionId: id }
					: { outcome: "cancelled" as const },
			};
		});
	let agent = startAgent(
		app,
		options.command,
		options.cwd,
		options.env ? { ...process.env, ...options.env } : undefined,
		options.stderr,
	);
	let { connection } = agent;
	let deadline = setTimeout(
		() => connection.close(new Error("ACP initialization timed out.")),
		30_000,
	);
	let sessionId: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel = () => {
		// Without a session there is no turn to wind down, so the agent's start is abandoned at once
		// rather than waited on; the finally below stops the agent.
		if (!sessionId) {
			connection.close(new Error("Investigation cancelled."));
			return;
		}
		void connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
		timer = setTimeout(() => {
			agent.kill("SIGKILL");
			connection.close();
		}, 3000);
	};
	options.signal.addEventListener("abort", cancel, { once: true });
	try {
		let initialized = await initialize(connection);
		if (initialized.protocolVersion !== PROTOCOL_VERSION) {
			throw new Error("Unsupported ACP version.");
		}
		let session = await connection.agent.request("session/new", {
			cwd: options.cwd,
			mcpServers: typeof options.mcpServers === "function"
				? options.mcpServers(initialized.agentCapabilities?.mcpCapabilities?.http === true)
				: options.mcpServers,
		});
		sessionId = session.sessionId;
		options.onStart?.();
		await options.onSession?.(sessionId);
		clearTimeout(deadline);
		deadline = setTimeout(
			() => connection.close(new Error("Investigation timed out.")),
			60 * 60 * 1000,
		);
		if (options.signal.aborted) {
			cancel();
			throw new Error("Investigation cancelled.");
		}
		let response = await connection.agent.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: options.prompt }],
		});
		return response.stopReason;
	} catch (error) {
		if (!sessionId && !options.signal.aborted && options.onStart) {
			options.onStart(await agent.failure(error));
		}
		throw error;
	} finally {
		options.signal.removeEventListener("abort", cancel);
		if (timer) clearTimeout(timer);
		clearTimeout(deadline);
		await agent.stop();
	}
}
