import { HarnessAgent } from "@ai-sdk/harness/agent";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

import { type DocumentRoom, documentTools } from "../agent/tools";
import { type HostedRepository, repositoryTools } from "../agent/repository";
import { GITHUB_TOOL_SCHEMAS } from "./github-tools";
import { PLANNER_TOOL_NAMES } from "./tool-names";
import { harnessFor } from "./harnesses";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { ToolSet } from "ai";
import type { ActiveOwnerBinding } from "../agent/active-owner";

const repositories = repositoryTools();
const githubPlaceholders: ToolSet = Object.fromEntries(
	Object.keys(GITHUB_TOOL_SCHEMAS).map(name => [
		name,
		tool({
			description: `Read ${name} for the selected repository.`,
			inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: true }),
			execute: async (): Promise<string> => {
				throw new Error("GitHub tools have not been bound for this turn");
			},
		}),
	]),
);

const plannerTools: ToolSet = { ...documentTools, ...repositories, ...githubPlaceholders };
export { PLANNER_TOOL_NAMES } from "./tool-names";

type PlannerCallOptions = {
	room: DocumentRoom;
	repository: HostedRepository;
	owner: ActiveOwnerBinding;
	githubTools: ToolSet;
	instructions: string;
	model?: string;
};

export function createPlannerAgent(harness: HarnessV1) {
	return new HarnessAgent({
		harness,
		tools: plannerTools,
		activeTools: PLANNER_TOOL_NAMES,
		permissionMode: "allow-reads",
		callOptionsSchema: z.custom<PlannerCallOptions>(),
		prepareCall: ({ options, ...rest }) => ({
			...rest,
			model: options.model,
			instructions: options.instructions,
			tools: { ...rest.tools, ...options.githubTools },
			toolsContext: Object.fromEntries(PLANNER_TOOL_NAMES.map(name => [name, {
				room: options.room,
				repository: options.repository,
				owner: options.owner,
			}])),
		}),
	});
}

export let plannerAgent = createPlannerAgent(harnessFor({ harness: "copilot-sdk" }));
