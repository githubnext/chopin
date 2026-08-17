/**
 * Backend-neutral MCP document protocol.
 *
 * Hosts authenticate callers and resolve repository-scoped documents. This
 * module only validates and presents their results through MCP.
 */

import { createHash } from "node:crypto";

import { lookup, parse, serialize, ulid, validate } from "@chopin/dialect";

import * as room from "./plan/room";

import type { Nodes, Parent, Root } from "mdast";

export type DocumentSummary = {
	id: string;
	title: string;
};

export type Document = DocumentSummary & {
	brief?: Brief;
	source: string;
	revision: number;
};

export type DocumentReader<Caller> = {
	list(caller: Caller, repository: string): Promise<DocumentSummary[]>;
	read(caller: Caller, id: string): Promise<Document | undefined>;
};

export type Brief = {
	goal: string;
	constraints: string[];
	settledDecisions: string[];
	openQuestions: string[];
	repositoryFindings: string[];
};

export type CreationOrigin = {
	idempotencyKey: string;
	fingerprint: string;
	repository: string;
	baseBranch: string;
	baseCommit: string;
	title: string;
};

export type CreateDocumentInput = CreationOrigin & {
	brief: Brief;
	plan: string;
};

export type CreatedDocument = Document & { url: string };

export type CreateDocument<Caller> = {
	create(
		caller: Caller,
		input: CreateDocumentInput,
	): Promise<
		| { kind: "created"; document: CreatedDocument }
		| { kind: "replayed"; document: CreatedDocument }
		| { kind: "conflict" }
		| { kind: "forbidden" }
	>;
};

export type McpOptions<Caller> = {
	/** The host owns authentication; MCP only receives its result. */
	caller(request: Request): Promise<Caller | undefined> | Caller | undefined;
	documents: DocumentReader<Caller>;
	create?: CreateDocument<Caller>;
};

type Tool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
};

const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
const REPOSITORY_PATTERN = "(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}";
const REPOSITORY_PATH_PATTERN = `^${OWNER_PATTERN}/${REPOSITORY_PATTERN}$`;
const OWNER = new RegExp(`^${OWNER_PATTERN}$`);
const REPOSITORY = new RegExp(`^${REPOSITORY_PATTERN}$`);
const MAX_DOCUMENT_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 120;
/** Read-only JSON-RPC calls need arguments, not document-sized request bodies. */
const MAX_REQUEST_BYTES = 64 * 1_024;

const DOCUMENT = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
	},
	required: ["id", "title"],
	additionalProperties: false,
};

const BRIEF = {
	type: "object",
	properties: {
		goal: { type: "string", minLength: 1 },
		constraints: { type: "array", items: { type: "string" } },
		settledDecisions: { type: "array", items: { type: "string" } },
		openQuestions: { type: "array", items: { type: "string" } },
		repositoryFindings: { type: "array", items: { type: "string" } },
	},
	required: ["goal", "constraints", "settledDecisions", "openQuestions", "repositoryFindings"],
	additionalProperties: false,
};

/** The host can change readers, but never the public tool contract. */
export const TOOLS: Tool[] = [
	{
		name: "list_documents",
		description: "List Chopin documents available in a repository.",
		inputSchema: {
			type: "object",
			properties: {
				repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
			},
			required: ["repository"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { documents: { type: "array", items: DOCUMENT } },
			required: ["documents"],
			additionalProperties: false,
		},
	},
	{
		name: "read_document",
		description: "Read a Chopin channel's canonical source and revision.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_ID_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				...DOCUMENT.properties,
				brief: BRIEF,
				source: { type: "string" },
				revision: { type: "integer", minimum: 0 },
			},
			required: ["id", "title", "source", "revision"],
			additionalProperties: false,
		},
	},
	{
		name: "create_document",
		description: "Create a Chopin document from a structured brief and canonical plan.",
		inputSchema: {
			type: "object",
			properties: {
				idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
				repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
				baseBranch: { type: "string", minLength: 1, maxLength: 255 },
				baseCommit: { type: "string", minLength: 1, maxLength: 64 },
				title: { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH },
				brief: BRIEF,
				plan: { type: "string", minLength: 1 },
			},
			required: [
				"idempotencyKey",
				"repository",
				"baseBranch",
				"baseCommit",
				"title",
				"brief",
				"plan",
			],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				...DOCUMENT.properties,
				brief: BRIEF,
				source: { type: "string" },
				revision: { type: "integer", minimum: 0 },
				url: { type: "string" },
			},
			required: ["id", "title", "brief", "source", "revision", "url"],
			additionalProperties: false,
		},
	},
];

type Call = {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
};

type Reply = {
	jsonrpc: "2.0";
	id: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};

function reply(id: unknown, result: unknown): Reply {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: unknown, code: number, message: string): Reply {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(
	value: unknown,
	isError = false,
): {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: unknown;
	isError?: true;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
		...(isError ? { isError: true as const } : {}),
	};
}

function toolCall(
	params: unknown,
): { name: string; arguments: Record<string, unknown> } | undefined {
	let value = record(params);
	if (!value || typeof value.name !== "string") return undefined;
	let arguments_ = value.arguments === undefined ? {} : record(value.arguments);
	return arguments_ ? { name: value.name, arguments: arguments_ } : undefined;
}

function isRepository(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let parts = value.split("/");
	return parts.length === 2 && OWNER.test(parts[0]!) && REPOSITORY.test(parts[1]!);
}

function isId(value: unknown): value is string {
	return typeof value === "string"
		&& Array.from(value).length <= MAX_DOCUMENT_ID_LENGTH
		&& value.trim().length > 0;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function nonblank(value: unknown, maximum: number): string | undefined {
	return typeof value === "string"
			&& Array.from(value).length <= maximum
			&& value.trim().length > 0
		? value
		: undefined;
}

type CreateArguments = Omit<CreateDocumentInput, "fingerprint">;

function createArguments(value: Record<string, unknown>): CreateArguments | undefined {
	let expected = [
		"idempotencyKey",
		"repository",
		"baseBranch",
		"baseCommit",
		"title",
		"brief",
		"plan",
	];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
	) return undefined;
	let brief = record(value.brief);
	let goal = nonblank(brief?.goal, 4_096);
	let constraints = strings(brief?.constraints);
	let settledDecisions = strings(brief?.settledDecisions);
	let openQuestions = strings(brief?.openQuestions);
	let repositoryFindings = strings(brief?.repositoryFindings);
	let idempotencyKey = nonblank(value.idempotencyKey, 128);
	let baseBranch = nonblank(value.baseBranch, 255);
	let baseCommit = nonblank(value.baseCommit, 64);
	let title = nonblank(value.title, MAX_TITLE_LENGTH);
	let plan = nonblank(value.plan, MAX_REQUEST_BYTES);
	if (
		!idempotencyKey
		|| !isRepository(value.repository)
		|| !baseBranch
		|| !baseCommit
		|| !title
		|| !goal
		|| !constraints
		|| !settledDecisions
		|| !openQuestions
		|| !repositoryFindings
		|| !plan
	) return undefined;
	return {
		idempotencyKey,
		repository: value.repository,
		baseBranch,
		baseCommit,
		title,
		brief: { goal, constraints, settledDecisions, openQuestions, repositoryFindings },
		plan,
	};
}

function identify(node: Nodes | Root): void {
	if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
		let component = lookup(node.name);
		if (
			component?.attributes.id?.required
			&& !node.attributes.some(attribute =>
				attribute.type === "mdxJsxAttribute" && attribute.name === "id"
			)
		) node.attributes.unshift({ type: "mdxJsxAttribute", name: "id", value: ulid() });
	}
	if ("children" in node) {
		for (let child of (node as Parent).children) identify(child);
	}
}

function canonical(source: string):
	| { source: string }
	| { issues: Array<{ code: string; message: string; path: string; offset?: number }> }
{
	let tree = parse(source);
	identify(tree);
	let result = validate(tree);
	if (!result.ok) return { issues: result.issues };
	let output = serialize(tree);
	room.validate(output);
	return { source: output };
}

function fingerprint(input: CreateArguments): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isJsonRpcId(value: unknown): value is string | number | null {
	return value === null || typeof value === "string" || typeof value === "number";
}

function hasObjectParams(call: Call): boolean {
	return call.params === undefined
		|| (call.method !== "initialize" && call.method !== "tools/list")
		|| record(call.params) !== undefined;
}

function acceptsEvents(request: Request): boolean {
	let selected: { specificity: number; quality: number } | undefined;
	for (let item of (request.headers.get("accept") ?? "*/*").split(",")) {
		let [media, ...parameters] = item.split(";").map(value => value.trim());
		let specificity = media?.toLowerCase() === "text/event-stream"
			? 2
			: media?.toLowerCase() === "text/*"
			? 1
			: media === "*/*"
			? 0
			: -1;
		if (specificity < 0) continue;
		let quality = 1;
		let parameter = parameters.find(value => value.split("=", 1)[0]?.trim().toLowerCase() === "q");
		if (parameter) {
			let value = parameter.slice(parameter.indexOf("=") + 1).trim();
			quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
		}
		if (
			!selected
			|| specificity > selected.specificity
			|| (specificity === selected.specificity && quality > selected.quality)
		) selected = { specificity, quality };
	}
	return (selected?.quality ?? 0) > 0;
}

async function requestBody(request: Request): Promise<{ body?: unknown; tooLarge: boolean }> {
	let declared = request.headers.get("content-length");
	if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BYTES) {
		return { tooLarge: true };
	}

	let reader = request.body?.getReader();
	if (!reader) throw new Error("request has no body");
	let chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			let { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			length += value.byteLength;
			if (length > MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => {});
				return { tooLarge: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	let bytes = new Uint8Array(length);
	let offset = 0;
	for (let chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
}

/** A stateless JSON-response Streamable HTTP MCP handler for read-only tools. */
export function handler<Caller>(
	options: McpOptions<Caller>,
): (request: Request) => Promise<Response> {
	async function dispatch(value: unknown, caller: Caller): Promise<Reply | undefined> {
		let call = record(value) as Call | undefined;
		if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
			return error(call?.id, -32600, "invalid request");
		}
		if (Object.hasOwn(call, "id") && !isJsonRpcId(call.id)) {
			return error(null, -32600, "invalid request");
		}
		if (!hasObjectParams(call)) return error(call.id, -32600, "invalid request");
		let notification = !Object.hasOwn(call, "id");
		let respond = (result: unknown) => notification ? undefined : reply(call.id, result);

		switch (call.method) {
			case "initialize":
				return respond({
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "chopin", version: "0.0.0" },
				});

			case "notifications/initialized":
				return undefined;

			case "tools/list":
				return respond({ tools: TOOLS });

			case "tools/call": {
				let tool = toolCall(call.params);
				if (!tool) {
					return notification
						? undefined
						: error(call.id, -32602, "invalid tool arguments");
				}
				if (tool.name === "list_documents") {
					if (
						Object.keys(tool.arguments).length !== 1 || !isRepository(tool.arguments.repository)
					) {
						return notification
							? undefined
							: error(call.id, -32602, "list_documents requires a repository");
					}
					return respond(
						text({ documents: await options.documents.list(caller, tool.arguments.repository) }),
					);
				}
				if (tool.name === "read_document") {
					if (Object.keys(tool.arguments).length !== 1 || !isId(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_document requires an id");
					}
					let document = await options.documents.read(caller, tool.arguments.id);
					return document ? respond(text(document)) : respond({ content: [], isError: true });
				}
				if (tool.name === "create_document") {
					let input = createArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "create_document requires a valid draft");
					}
					let prepared = canonical(input.plan);
					if ("issues" in prepared) return respond(text({ issues: prepared.issues }, true));
					if (!options.create) return respond({ content: [], isError: true });
					let outcome = await options.create.create(caller, {
						...input,
						plan: prepared.source,
						fingerprint: fingerprint(input),
					});
					if (outcome.kind === "created" || outcome.kind === "replayed") {
						return respond(text(outcome.document));
					}
					if (outcome.kind === "conflict") {
						return respond(text({ code: "idempotency-conflict" }, true));
					}
					return respond({ content: [], isError: true });
				}
				return notification ? undefined : error(call.id, -32601, "tool not found");
			}

			default:
				return notification ? undefined : error(call.id, -32601, "method not found");
		}
	}

	return async request => {
		let caller = await options.caller(request);
		if (caller === undefined) return new Response("unauthorized", { status: 401 });

		if (request.method === "GET") {
			if (!acceptsEvents(request)) return new Response("not acceptable", { status: 406 });
			return new Response(null, {
				headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
			});
		}
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
		}

		let body: unknown;
		try {
			let read = await requestBody(request);
			if (read.tooLarge) return new Response("request too large", { status: 413 });
			body = read.body;
		} catch {
			return Response.json(error(null, -32700, "parse error"));
		}
		let result = await dispatch(body, caller);
		return result ? Response.json(result) : new Response(null, { status: 202 });
	};
}
