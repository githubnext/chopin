import { expect, it } from "bun:test";
import { asSchema, tool } from "ai";
import { z } from "zod";

import { relay } from "../../connector/src/implementation";
import { documentTools } from "./agent/tools";
import { jobTools } from "./agent/job-tools";
import { repositoryTools } from "./agent/repository";
import { createScopedTools } from "./agent/scoped-tools";
import { connectorSchemas } from "./experiments/mcp-schema";
import {
	descriptionSchema,
	historySummarySchema,
	privateEvidenceSchema,
	publicEvidenceSchema,
	researchAnswerSchema,
	researchBriefSchema,
	researchReportSchema,
} from "./harness/agents";
import { GITHUB_TOOL_SCHEMAS } from "./harness/github-tools";
import {
	BACKGROUND_TOOL_NAMES,
	PLANNER_TOOL_NAMES,
	VISUAL_PLANNER_TOOL_NAMES,
} from "./harness/tool-names";
import { webSearchTool } from "./harness/web-search";
import { TOOLS } from "./mcp";
import { implementationSchemas } from "./tasks/connector";

import type { ToolSet } from "ai";

/**
 * Regular-expression constructs that model providers' JSON-schema validators refuse, failing the
 * whole request rather than one tool. GitHub Copilot's GPT models answer 400 "regex lookaround is
 * not supported" for lookahead and lookbehind; OpenAI's strict schemas also lack backreferences.
 * The rest are not JavaScript-portable or not in the ECMA-262 subset JSON Schema names for
 * `pattern`, so a validator that compiles them as RE2 or ECMA rejects them too.
 */
const REFUSED: [string, RegExp][] = [
	["lookahead", /\(\?[=!]/],
	["lookbehind", /\(\?<[=!]/],
	["numbered backreference", /\\[1-9]/],
	["named backreference", /\\k</],
	["atomic group", /\(\?>/],
	["inline modifier", /\(\?[a-zA-Z-]+[):]/],
	["conditional", /\(\?\(/],
];

/** The constructs in a pattern's source; an escaped `\(` or `\\` never starts one. */
function constructs(source: string): string[] {
	// Each escape becomes two inert characters, except a backreference, which stays itself.
	let bare = source.replace(
		/\\(k<|[1-9]|[^])/g,
		(escape, next: string) => next === "k<" || /[1-9]/.test(next) ? escape : "__",
	);
	return REFUSED.filter(([, construct]) => construct.test(bare)).map(([kind]) => kind);
}

/** Every `pattern` in a JSON schema, with its JSON path. */
function patterns(schema: unknown, path = "$"): [string, string][] {
	if (Array.isArray(schema)) {
		return schema.flatMap((item, index) => patterns(item, `${path}[${index}]`));
	}
	if (!schema || typeof schema !== "object") return [];
	return Object.entries(schema).flatMap(([key, value]) => [
		...(key === "pattern" && typeof value === "string"
			? [[`${path}.pattern`, value] as [string, string]]
			: []),
		...(key === "patternProperties" && value && typeof value === "object"
			? Object.keys(value).map(source => [`${path}.patternProperties`, source] as [string, string])
			: []),
		...patterns(value, `${path}.${key}`),
	]);
}

function refusals(schemas: Record<string, unknown>): string[] {
	return Object.entries(schemas).flatMap(([name, schema]) =>
		patterns(schema).flatMap(([path, source]) =>
			constructs(source).map(kind => `${name} ${path}: ${kind} in ${JSON.stringify(source)}`)
		)
	);
}

async function jsonSchemas(tools: ToolSet): Promise<Record<string, unknown>> {
	return Object.fromEntries(
		await Promise.all(
			Object.entries(tools).map(async ([name, value]) => [
				name,
				await asSchema(value.inputSchema).jsonSchema,
			]),
		),
	);
}

function zodSchemas(schemas: Record<string, z.ZodType>): Record<string, unknown> {
	// The connector MCP endpoints list their tools through exactly this conversion.
	return Object.fromEntries(
		Object.entries(schemas).map((
			[name, schema],
		) => [name, z.toJSONSchema(schema, { unrepresentable: "any" })]),
	);
}

async function plannerSchemas() {
	let web = await webSearchTool(
		{ kind: "active-planner", token: "token", expiresAt: new Date(Date.now() + 60_000) } as never,
		{
			createClient: async () => ({
				tools: async () => ({
					web_search: tool({ inputSchema: z.object({}), execute: async () => "" }),
				}),
				close: async () => {},
			}),
		},
	);
	if (!web.ok) throw new Error("web search tool was not built");
	// The tools `harness/agents.ts` gives every Planner profile and research worker.
	let tools: ToolSet = {
		...documentTools,
		...repositoryTools(),
		...Object.fromEntries(
			Object.entries(GITHUB_TOOL_SCHEMAS).map(([name, { inputSchema }]) => [
				name,
				tool({ inputSchema, execute: async () => "" }),
			]),
		),
		...jobTools,
		...createScopedTools(),
		web_search: web.value.tool,
	};
	let offered = new Set([
		...PLANNER_TOOL_NAMES,
		...VISUAL_PLANNER_TOOL_NAMES,
		...Object.values(BACKGROUND_TOOL_NAMES).flat(),
	]);
	expect([...offered].filter(name => !Object.hasOwn(tools, name))).toEqual([]);
	return jsonSchemas(tools);
}

function outputSchemas(): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries({
			descriptionSchema,
			historySummarySchema,
			privateEvidenceSchema,
			publicEvidenceSchema,
			researchAnswerSchema,
			researchBriefSchema,
			researchReportSchema,
		}).map(([name, schema]) => [`output ${name}`, z.toJSONSchema(schema)]),
	);
}

function mcpSchemas(): Record<string, unknown> {
	return Object.fromEntries(
		TOOLS.flatMap(tool => [
			[`mcp ${tool.name}`, tool.inputSchema],
			[`mcp ${tool.name} output`, tool.outputSchema],
		]),
	);
}

function connectorEndpointSchemas(): Record<string, unknown> {
	return Object.fromEntries(
		[
			connectorSchemas(false),
			connectorSchemas(true),
			connectorSchemas(true, true),
			implementationSchemas(false),
			implementationSchemas(true),
			implementationSchemas(true, true),
		].flatMap(schemas => Object.entries(zodSchemas(schemas)))
			.map(([name, schema]) => [`connector ${name}`, schema]),
	);
}

/** What the local bridge adds to a run's relayed server tools. */
async function bridgeSchemas(): Promise<Record<string, unknown>> {
	let create = await relay({
		tools: async () => ({
			tools: [{ name: "upload_investigation_image", inputSchema: { type: "object" as const } }],
		}),
		invoke: async () => ({ content: [] }),
	}, "/worktree");
	// The server package has no MCP client, so this speaks JSON-RPC to the bridge directly.
	let listed = Promise.withResolvers<{ tools: { name: string; inputSchema: unknown }[] }>();
	let transport = {
		onmessage: undefined as ((message: unknown) => void) | undefined,
		start: async () => {},
		close: async () => {},
		send: async (message: { result?: never }) => listed.resolve(message.result!),
	};
	let server = create();
	await server.connect(transport as never);
	transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	try {
		return Object.fromEntries(
			(await listed.promise).tools.map(tool => [`bridge ${tool.name}`, tool.inputSchema]),
		);
	} finally {
		await server.close();
	}
}

it("finds lookaround and backreferences in a schema's patterns", () => {
	expect(refusals({
		owner: { properties: { owner: { pattern: "a(?=b)" } } },
		repository: { items: [{ pattern: "(?!\\.$)x" }] },
		behind: { pattern: "(?<=a)b" },
		back: { patternProperties: { "(a)\\1": {} } },
		plain: { pattern: "^[A-Za-z0-9](?:-?[A-Za-z0-9])*$" },
		group: { pattern: "(?<name>a)" },
		escaped: { pattern: "\\(?=\\\\1" },
	})).toEqual([
		'owner $.properties.owner.pattern: lookahead in "a(?=b)"',
		'repository $.items[0].pattern: lookahead in "(?!\\\\.$)x"',
		'behind $.pattern: lookbehind in "(?<=a)b"',
		'back $.patternProperties: numbered backreference in "(a)\\\\1"',
	]);
});

it("offers models no tool or output schema with a pattern providers refuse", async () => {
	let schemas = {
		...await plannerSchemas(),
		...outputSchemas(),
		...mcpSchemas(),
		...connectorEndpointSchemas(),
		...await bridgeSchemas(),
	};
	expect(Object.keys(schemas).length).toBeGreaterThan(80);
	expect(refusals(schemas)).toEqual([]);
});
