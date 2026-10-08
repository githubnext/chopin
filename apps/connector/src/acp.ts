import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
	McpServer,
	RequestPermissionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";

export type AgentOptions = {
	command: string[];
	cwd: string;
	prompt: string;
	mcpServers: McpServer[];
	signal: AbortSignal;
	onUpdate: (value: SessionNotification) => void;
	permission: (request: RequestPermissionRequest) => Promise<string | undefined>;
	stderr?: (chunk: string) => void;
};

/** One protocol implementation; agent-specific launch arguments belong to local configuration. */
export async function runAgent(options: AgentOptions): Promise<string> {
	if (options.signal.aborted) throw new Error("Investigation cancelled.");
	if (!options.command[0]) throw new Error("An ACP command is required.");
	let child = spawn(options.command[0], options.command.slice(1), {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let kill = (signal: NodeJS.Signals = "SIGTERM") => {
		try {
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch { /* Process may have already exited. */ }
	};
	child.stderr.on("data", chunk => options.stderr?.(String(chunk)));
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
	let connection = app.connect(ndJsonStream(
		Writable.toWeb(child.stdin),
		Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
	));
	let deadline = setTimeout(
		() => connection.close(new Error("ACP initialization timed out.")),
		30_000,
	);
	let sessionId: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel = () => {
		if (sessionId) void connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
		timer = setTimeout(() => {
			kill("SIGKILL");
			connection.close();
		}, 3000);
	};
	child.once("error", error => connection.close(error));
	child.once("exit", () => connection.close(new Error("ACP agent exited.")));
	options.signal.addEventListener("abort", cancel, { once: true });
	try {
		let initialized = await connection.agent.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: { name: "chopin", version: "0.1.0" },
			clientCapabilities: {},
		});
		if (initialized.protocolVersion !== PROTOCOL_VERSION) {
			throw new Error("Unsupported ACP version.");
		}
		let session = await connection.agent.request("session/new", {
			cwd: options.cwd,
			mcpServers: options.mcpServers,
		});
		sessionId = session.sessionId;
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
	} finally {
		options.signal.removeEventListener("abort", cancel);
		if (timer) clearTimeout(timer);
		clearTimeout(deadline);
		connection.close();
		kill();
		let force = setTimeout(() => kill("SIGKILL"), 1000);
		force.unref();
		child.once("exit", () => clearTimeout(force));
	}
}
