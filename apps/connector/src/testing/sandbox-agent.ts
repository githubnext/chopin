import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { planFromEnvironment, report, sandboxChecks } from "./sandbox-checks";

/**
 * An ACP agent that does what the sandbox tests ask of an agent: on its prompt it tries each thing
 * from inside the sandbox, writes what happened to SANDBOX_REPORT and ends its turn.
 */
let cwd = "";
let app = new AgentApp()
	.onRequest("initialize", () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentInfo: { name: "sandbox-agent", version: "1" },
		agentCapabilities: {},
	}))
	.onRequest("session/new", ({ params: input }) => {
		cwd = input.cwd;
		return { sessionId: "sandbox-session" };
	})
	.onRequest("session/prompt", async () => {
		report(process.env.SANDBOX_REPORT!, await sandboxChecks(planFromEnvironment(), cwd));
		return { stopReason: "end_turn" as const };
	});

app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout),
		Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
	),
);
