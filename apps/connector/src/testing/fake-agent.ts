import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let app = new AgentApp()
	.onRequest("initialize", () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
	.onRequest("session/new", ({ params: input }) => {
		if (!input.cwd.startsWith("/")) throw new Error("Expected absolute cwd");
		return { sessionId: "test-session" };
	})
	.onRequest("session/prompt", async ({ params: input, client }) => {
		await client.notify("session/update", {
			sessionId: input.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Inspecting the checkout" },
			},
		});
		return { stopReason: "end_turn" as const };
	});
app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout),
		Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
	),
);
