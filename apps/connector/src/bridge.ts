import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { capabilities, parseResult, resultSchema } from "@chopin/experiment";
import type { Result, RunInput } from "@chopin/experiment";

/**
 * How an agent starts this connector's stdio bridge. A compiled `chopin` binary is its own entry
 * point: its argv[1] is a virtual `/$bunfs/` path inside the binary that no other process can run.
 */
export function bridgeCommand(
	compiled = Bun.isStandaloneExecutable,
	execPath = process.execPath,
	script = process.argv[1]!,
) {
	return { command: execPath, args: compiled ? ["bridge"] : [resolve(script), "bridge"] };
}

export function createBridge(input: RunInput, submit: (result: Result) => Promise<void>) {
	let server = new McpServer({ name: "chopin-investigation", version: "0.1.0" });
	server.registerTool("read_investigation", {
		description: "Read the sealed investigation, source context and accepted result format.",
		inputSchema: {},
	}, () => ({ content: [{ type: "text", text: JSON.stringify({ input, capabilities }) }] }));
	server.registerTool("submit_investigation_result", {
		description:
			"Submit captured evidence for this run. The connector publishes after the turn completes.",
		inputSchema: { result: resultSchema },
	}, async ({ result }) => {
		await submit(parseResult(result));
		return {
			content: [{ type: "text", text: "Candidate accepted. Finish this turn to publish." }],
		};
	});
	return server;
}
