import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { remote } from "./mcp";

export async function implementationBridge(api: Awaited<ReturnType<typeof remote>>) {
	let tools = await api.tools();
	let names = new Set(tools.tools.map(tool => tool.name));
	let server = new Server({ name: "chopin-implementation", version: "0.1.0" }, {
		capabilities: { tools: {} },
	});
	server.setRequestHandler(ListToolsRequestSchema, () => tools);
	server.setRequestHandler(CallToolRequestSchema, async request => {
		if (!names.has(request.params.name)) {
			return { isError: true, content: [{ type: "text", text: "Tool unavailable for this run." }] };
		}
		return api.invoke(request.params.name, request.params.arguments ?? {});
	});
	return server;
}

export let implementationPrompt = [
	"Read the human-approved graph and document with read_implementation from Chopin's MCP server.",
	"You are the orchestrator. You MUST use sub-agents for independent dependency-ready tasks.",
	"Give each sub-agent explicit file ownership and tell it other agents are working in the repository.",
	"Use separate worktrees for concurrent PRs; integrate prerequisite changes before dependent work.",
	"Own all MCP reporting: start_task, block_task, report_pr, complete_task and report_verification.",
	"The connector already claimed this exact graph. Never claim another run or change the approved plan.",
	"Open small reviewable PRs, linking the document URL and its #task-ID anchors. Never merge PRs.",
	"If a new human decision is needed, block the affected task with its question and stop that work.",
	"If scope or dependencies must change, request_revision and stop.",
	"Verify each task's acceptance criteria and graph-wide integration. Never invent verification evidence.",
	"If your agent cannot delegate to sub-agents, report a task blocker explaining that limitation and stop.",
].join("\n");

export let rebuildPrompt = [
	"The document changed after its pull requests were built. Bring those pull requests up to date.",
	"Call read_rebuild from Chopin's MCP server; implement only the change from before to after.",
	"Decide which existing pull requests the change affects.",
	"For each one, run `gh pr checkout <url>` in this worktree or a sub-worktree, implement only its",
	"part of the change, make one commit named after the document change, and push.",
	"Never open new pull requests. Never merge.",
	"Code that fits no existing pull request goes on the most closely related one.",
	"If the change needs no code, make no commits.",
	"Finally call report_rebuild with a summary, every commit you pushed, and one task per change.",
].join("\n");
