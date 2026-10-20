import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let client = new Client({ name: "acp-smoke-proxy", version: "1" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(process.env.CHOPIN_SMOKE_URL!), {
		requestInit: { headers: { Authorization: `Bearer ${process.env.CHOPIN_SMOKE_TOKEN!}` } },
	}),
);
let server = new Server({ name: "acp-smoke-proxy", version: "1" }, {
	capabilities: { tools: {} },
});
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params));
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => void client.close());
