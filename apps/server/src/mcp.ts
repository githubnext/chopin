/**
 * Backend-neutral MCP read protocol.
 *
 * Hosts authenticate callers and resolve repository-scoped documents. This
 * module only validates and presents their results through MCP.
 */

export type DocumentSummary = {
	id: string;
	title: string;
};

export type Document = DocumentSummary & {
	source: string;
	revision: number;
};

export type DocumentReader<Caller> = {
	list(caller: Caller, repository: string): Promise<DocumentSummary[]>;
	read(caller: Caller, id: string): Promise<Document | undefined>;
};

export type McpOptions<Caller> = {
	/** The host owns authentication; MCP only receives its result. */
	caller(request: Request): Promise<Caller | undefined> | Caller | undefined;
	documents: DocumentReader<Caller>;
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

const DOCUMENT = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
	},
	required: ["id", "title"],
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
			properties: { id: { type: "string", minLength: 1, pattern: "\\S" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				...DOCUMENT.properties,
				source: { type: "string" },
				revision: { type: "integer", minimum: 0 },
			},
			required: ["id", "title", "source", "revision"],
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
): { content: Array<{ type: "text"; text: string }>; structuredContent: unknown } {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
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
	return typeof value === "string" && value.trim().length > 0;
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
	return (request.headers.get("accept") ?? "*/*")
		.split(",")
		.map(value => value.trim().split(";", 1)[0])
		.some(value => value === "text/event-stream" || value === "*/*");
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
			body = await request.json();
		} catch {
			return Response.json(error(null, -32700, "parse error"));
		}
		let result = await dispatch(body, caller);
		return result ? Response.json(result) : new Response(null, { status: 202 });
	};
}
