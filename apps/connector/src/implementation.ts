import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { imageFileArguments } from "./image-file";
import type { remote } from "./mcp";

/**
 * Relay a run's server tools. With a worktree `root`, a run that may upload images also gets the
 * connector-local upload_image_file, which reads the file here and forwards its bytes.
 */
export async function implementationBridge(
	api: Pick<Awaited<ReturnType<typeof remote>>, "tools" | "invoke">,
	root?: string,
) {
	return (await relay(api, root))();
}

/** List the run's tools once and return a factory for relaying servers, one per transport. */
export async function relay(
	api: Pick<Awaited<ReturnType<typeof remote>>, "tools" | "invoke">,
	root?: string,
) {
	let listed = await api.tools();
	let names = new Set(listed.tools.map(tool => tool.name));
	let local = !!root && names.has("upload_investigation_image");
	let tools = local
		? {
			...listed,
			tools: [...listed.tools, {
				name: "upload_image_file",
				description:
					"Upload a PNG, JPEG or WebP screenshot (at most 1 MiB) saved in this worktree and "
					+ "return its image path for submit_spike_result.",
				inputSchema: {
					type: "object" as const,
					properties: {
						path: {
							type: "string",
							description: "The image file, relative to the worktree root.",
						},
					},
					required: ["path"],
					additionalProperties: false,
				},
			}],
		}
		: listed;
	return () => {
		let server = new Server({ name: "chopin-implementation", version: "0.1.0" }, {
			capabilities: { tools: {} },
		});
		server.setRequestHandler(ListToolsRequestSchema, () => tools);
		server.setRequestHandler(CallToolRequestSchema, async request => {
			let args = request.params.arguments ?? {};
			if (local && request.params.name === "upload_image_file") {
				try {
					if (typeof args.path !== "string" || !args.path) throw new Error("Give an image path.");
					return await api.invoke(
						"upload_investigation_image",
						await imageFileArguments(root!, args.path),
					);
				} catch (error) {
					let text = error instanceof Error ? error.message : "Image upload failed.";
					return { isError: true, content: [{ type: "text", text }] };
				}
			}
			if (!names.has(request.params.name)) {
				return {
					isError: true,
					content: [{ type: "text", text: "Tool unavailable for this run." }],
				};
			}
			return api.invoke(request.params.name, args);
		});
		return server;
	};
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

/** A living document's first build: its run ends at the last complete_task, with no verification. */
export let liveImplementationPrompt = [
	"Read the human-approved graph and document with read_implementation from Chopin's MCP server.",
	"You are the orchestrator. You MUST use sub-agents for independent dependency-ready tasks.",
	"Give each sub-agent explicit file ownership and tell it other agents are working in the repository.",
	"Use separate worktrees for concurrent PRs; integrate prerequisite changes before dependent work.",
	"Own all MCP reporting: start_task, block_task, report_pr and complete_task.",
	"The connector already claimed this exact graph. Never claim another run or change the approved plan.",
	"Open small reviewable PRs, linking the document URL and its #task-ID anchors. Never merge PRs.",
	"If a new human decision is needed, block the affected task with its question and stop that work.",
	"Verify each task's acceptance criteria before completing it. Never invent verification evidence.",
	"This is a living document: the run ends at the last complete_task. Stop there.",
	"If your agent cannot delegate to sub-agents, report a task blocker explaining that limitation and stop.",
].join("\n");

export let rebuildPrompt = [
	"The document changed after its pull requests were built. Bring those pull requests up to date.",
	"Call read_rebuild from Chopin's MCP server; implement only the change from before to after.",
	"Decide which existing pull requests the change affects.",
	"For each one, run `gh pr checkout <url>` in this worktree or a sub-worktree, implement only its",
	"part of the change, make one commit named after the document change, and push.",
	"read_rebuild may also list outstanding tasks the first build stopped short of, with blockers.",
	"Finish each outstanding task as the current document now describes it: commit on its pull",
	"request, or open one pull request only for an outstanding task that has none.",
	"Never open any other pull request. Never merge.",
	"Code that fits no existing pull request goes on the most closely related one.",
	"If the change needs no code and nothing is outstanding, make no commits.",
	"Finally call report_rebuild with a summary, every commit you pushed, and one task per new change.",
	"Give report_rebuild an outstanding entry for every outstanding task: outcome done with its pull",
	"request, blocked with the blocker that still stops it, or dropped if the document no longer needs it.",
].join("\n");
