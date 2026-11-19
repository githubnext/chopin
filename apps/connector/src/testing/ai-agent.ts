import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

/**
 * An ACP agent that calls its model as a coding agent would, with the key and base URL its
 * environment gives it, and writes to AI_AGENT_REPORT what it was answered, what its environment
 * holds, every file of the state directory a run gave it, and what came of reading each of AI_AGENT_PEEK.
 */
function read(path: string): { text: string } | { error: string } {
	try {
		return { text: readFileSync(path, "utf8") };
	} catch (error) {
		return { error: (error as NodeJS.ErrnoException).code ?? String(error) };
	}
}

function files(directory: string, into: Record<string, string> = {}) {
	for (let name of readdirSync(directory)) {
		let path = join(directory, name);
		if (statSync(path).isDirectory()) files(path, into);
		else into[path] = readFileSync(path, "utf8");
	}
	return into;
}

let app = new AgentApp()
	.onRequest("initialize", () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentInfo: { name: "ai-agent", version: "1" },
		agentCapabilities: {},
	}))
	.onRequest("session/new", () => ({ sessionId: "ai-session" }))
	.onRequest("session/prompt", async () => {
		let answer: unknown;
		try {
			let response = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
			});
			answer = { status: response.status, body: await response.json() };
		} catch (error) {
			answer = { error: String(error) };
		}
		let home = process.env.ATOMIC_CODING_AGENT_DIR;
		let state = home && basename(dirname(home)).endsWith(".agent") ? dirname(home) : undefined;
		writeFileSync(
			process.env.AI_AGENT_REPORT!,
			JSON.stringify({
				answer,
				env: process.env,
				state: state ? files(state) : {},
				peeked: Object.fromEntries(
					(process.env.AI_AGENT_PEEK ?? "").split(",").filter(Boolean).map(path => [
						path,
						read(path),
					]),
				),
			}),
		);
		return { stopReason: "end_turn" as const };
	});

app.connect(
	ndJsonStream(
		Writable.toWeb(process.stdout),
		Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
	),
);
