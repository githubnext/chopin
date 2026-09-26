import { HarnessAgent } from "@ai-sdk/harness/agent";
import { jsonSchema, Output, tool } from "ai";
import { z } from "zod";

import { type DocumentRoom, documentTools } from "../agent/tools";
import { type HostedRepository, repositoryTools } from "../agent/repository";
import { harnessSelection } from "../config";
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

export let plannerAgent = createPlannerAgent(harnessFor(harnessSelection()));

type WorkerCallOptions = {
	model: string;
	instructions: string;
	webSearch?: ToolSet["web_search"];
	webContext?: { credential: unknown };
};

let finding = z.string().min(1).max(2_000);
let source = z.object({ title: z.string().min(1).max(500), url: z.string().min(1).max(2_048) })
	.strict();
let urls = z.array(z.string().min(1).max(2_048));

export let descriptionSchema = z.object({ description: z.string().min(1) }).strict();
export let publicEvidenceSchema = z.object({
	findings: z.array(finding).max(10),
	sources: z.array(source).max(10),
}).strict();
export let privateEvidenceSchema = z.object({ findings: z.array(finding).max(10) }).strict();
export let researchReportSchema = z.object({
	title: z.string().min(1).max(500),
	summary: finding,
	findings: z.array(z.object({ text: finding, sourceUrls: urls.max(10) }).strict()).max(10),
	caveats: z.array(finding).max(10),
}).strict();
export let researchAnswerSchema = z.object({
	text: z.string().min(1).max(16_000),
	sourceUrls: urls.max(64),
}).strict();

function structuredAgent<Schema extends z.ZodType>(
	harness: HarnessV1,
	schema: Schema,
	web: boolean,
) {
	let placeholder = tool({
		description: "Search public web evidence.",
		inputSchema: jsonSchema({
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		}),
		execute: async (): Promise<string> => {
			throw new Error("Web search has not been bound for this turn");
		},
	});
	return new HarnessAgent({
		harness,
		tools: web ? { web_search: placeholder } : {},
		activeTools: web ? ["web_search"] : [],
		permissionMode: "allow-reads",
		output: Output.object({ schema }),
		callOptionsSchema: z.custom<WorkerCallOptions>(),
		prepareCall: ({ options, ...rest }) => ({
			...rest,
			model: options.model,
			instructions: options.instructions,
			tools: options.webSearch ? { web_search: options.webSearch } : rest.tools,
			toolsContext: options.webContext ? { web_search: options.webContext } : {} as never,
		}),
	});
}

export function createSummaryAgent(harness: HarnessV1) {
	return structuredAgent(harness, descriptionSchema, false);
}

export function createResearchAgent(harness: HarnessV1) {
	return structuredAgent(harness, publicEvidenceSchema, true);
}

export let summaryAgent = createSummaryAgent(harnessFor(harnessSelection()));
export let researchAgent = createResearchAgent(harnessFor(harnessSelection()));
export let researchPrivateAgent = structuredAgent(
	harnessFor(harnessSelection()),
	privateEvidenceSchema,
	false,
);
export let researchReportAgent = structuredAgent(
	harnessFor(harnessSelection()),
	researchReportSchema,
	false,
);
export let researchAnswerAgent = structuredAgent(
	harnessFor(harnessSelection()),
	researchAnswerSchema,
	false,
);
