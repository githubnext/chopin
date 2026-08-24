/**
 * Backend-neutral MCP document protocol.
 *
 * Hosts authenticate callers and resolve repository-scoped documents. This
 * module only validates and presents their results through MCP.
 */

import {
	BRIEF,
	isRepository,
	MAX_REQUEST_BYTES,
	MAX_TITLE_LENGTH,
	prepare,
	REPOSITORY_PATH_PATTERN,
} from "./mcp/create";
import { isLifecycleTool, LIFECYCLE_TOOLS, lifecycleCall } from "./mcp/lifecycle";
import { normalizedTitle } from "./channels/title";

import type { Brief, CreateDocumentInput } from "./mcp/create";
import type { Run, Version } from "./tasks/graphs";
import type { LifecycleArguments } from "./mcp/lifecycle";
import type { ImplementationLifecycle } from "./tasks/lifecycle";

export type { Brief, CreateDocumentInput, CreationOrigin } from "./mcp/create";

export type DocumentSummary = {
	id: string;
	title: string;
	archivedAt?: string;
};

export type Document = DocumentSummary & {
	brief?: Brief;
	source: string;
	revision: number;
};

export type DocumentReader<Caller> = {
	list(
		caller: Caller,
		repository: string,
		includeArchived?: boolean,
	): Promise<DocumentSummary[] | "forbidden">;
	read(caller: Caller, id: string): Promise<Document | undefined>;
};

export type CreatedDocument = Document & { url: string };

export type Implementation = {
	document: Document;
	repository: { name: string; baseBranch: string; baseCommit: string };
	graph: Version;
	execution: { state: "idle" } | { state: "active"; run: Run };
	activity?: ImplementationLifecycle["activity"];
	history: ImplementationLifecycle["history"];
};

export type ImplementationInput = {
	id: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	repository: string;
	branch: string;
	commit: string;
	client: { name: string; version: string; session: string };
};

export type Implementations<Caller> = {
	readImplementation(caller: Caller, id: string): Promise<Implementation | undefined | "forbidden">;
	startImplementation(
		caller: Caller,
		input: ImplementationInput,
	): Promise<
		| { kind: "started"; run: Run }
		| { kind: "active"; run: Run }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "refused"; reason: string }
	>;
	reportLifecycle?(
		caller: Caller,
		input: LifecycleArguments,
	): Promise<
		| { kind: "accepted" | "replayed"; lifecycle: ImplementationLifecycle }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "refused"; reason: string }
	>;
};

export type CreateDocument<Caller> = {
	create(
		caller: Caller,
		input: CreateDocumentInput,
	): Promise<
		| { kind: "created"; document: CreatedDocument }
		| { kind: "replayed"; document: CreatedDocument }
		| { kind: "conflict" }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
	>;
};

export type RenameDocumentInput = {
	id: string;
	title: string;
};

export type RenameDocument<Caller> = {
	rename(
		caller: Caller,
		input: RenameDocumentInput,
	): Promise<
		| { kind: "renamed" | "unchanged"; document: DocumentSummary }
		| { kind: "archived" | "conflict" | "forbidden" | "unavailable" }
	>;
};

export type ArchiveDocument<Caller> = {
	archive(
		caller: Caller,
		id: string,
	): Promise<
		| { kind: "archived" | "unchanged"; document: DocumentSummary }
		| { kind: "forbidden" | "unavailable" }
	>;
};

export type RestoreDocument<Caller> = {
	restore(
		caller: Caller,
		id: string,
	): Promise<
		| { kind: "restored" | "unchanged"; document: DocumentSummary }
		| { kind: "forbidden" | "unavailable" }
	>;
};

export type McpOptions<Caller> = {
	/** The host owns authentication; MCP only receives its result. */
	caller(request: Request): Promise<Caller | undefined> | Caller | undefined;
	documents: DocumentReader<Caller>;
	create?: CreateDocument<Caller>;
	rename?: RenameDocument<Caller>;
	archive?: ArchiveDocument<Caller>;
	restore?: RestoreDocument<Caller>;
	implementations?: Implementations<Caller>;
};

type Tool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
};

const MAX_DOCUMENT_ID_LENGTH = 128;
const MAX_DOCUMENT_LOCATOR_LENGTH = 2_048;

const DOCUMENT_IDENTITY = {
	id: { type: "string" },
	title: { type: "string" },
};

const ACTIVE_DOCUMENT = {
	type: "object",
	properties: DOCUMENT_IDENTITY,
	required: ["id", "title"],
	additionalProperties: false,
};

const DOCUMENT = {
	type: "object",
	properties: {
		...DOCUMENT_IDENTITY,
		archivedAt: { type: "string", format: "date-time" },
	},
	required: ["id", "title"],
	additionalProperties: false,
};

const ARCHIVED_DOCUMENT = {
	...DOCUMENT,
	required: ["id", "title", "archivedAt"],
};

function outcome(codes: string[]) {
	return {
		type: "object",
		properties: { code: { type: "string", enum: codes } },
		required: ["code"],
		additionalProperties: false,
	};
}

const IMPLEMENTATION = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_ID_LENGTH },
		planRevision: { type: "integer", minimum: 0 },
		graphVersion: { type: "integer", minimum: 1 },
		graphRevision: { type: "integer", minimum: 1 },
		repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
		branch: { type: "string", minLength: 1, maxLength: 255 },
		commit: { type: "string", minLength: 1, maxLength: 64 },
	},
	required: [
		"id",
		"planRevision",
		"graphVersion",
		"graphRevision",
		"repository",
		"branch",
		"commit",
	],
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
				includeArchived: { type: "boolean", default: false },
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
		description: "Read a Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
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
	{
		name: "rename_document",
		description: "Rename a Chopin document without changing its canonical plan or revision.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_ID_LENGTH,
					pattern: "\\S",
				},
				title: { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH },
			},
			required: ["id", "title"],
			additionalProperties: false,
		},
		outputSchema: {
			oneOf: [
				ACTIVE_DOCUMENT,
				outcome([
					"document-archived",
					"title-conflict",
					"repository-forbidden",
					"document-unavailable",
				]),
			],
		},
	},
	{
		name: "archive_document",
		description: "Archive a Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			oneOf: [
				ARCHIVED_DOCUMENT,
				outcome(["repository-forbidden", "document-unavailable"]),
			],
		},
	},
	{
		name: "restore_document",
		description: "Restore an archived Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			oneOf: [
				ACTIVE_DOCUMENT,
				outcome(["repository-forbidden", "document-unavailable"]),
			],
		},
	},
	{
		name: "read_implementation",
		description:
			"Read the approved implementation graph, plan and repository context by document ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_LOCATOR_LENGTH },
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	{
		name: "start_implementation",
		description: "Atomically claim the current approved implementation graph.",
		inputSchema: IMPLEMENTATION,
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	...LIFECYCLE_TOOLS,
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

type StartArguments = Omit<ImplementationInput, "client">;

function startArguments(value: Record<string, unknown>): StartArguments | undefined {
	let expected = [
		"id",
		"planRevision",
		"graphVersion",
		"graphRevision",
		"repository",
		"branch",
		"commit",
	];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
	) return undefined;
	if (
		!isId(value.id)
		|| !isRepository(value.repository)
		|| typeof value.branch !== "string"
		|| !value.branch.trim()
		|| typeof value.commit !== "string"
		|| !value.commit.trim()
		|| !Number.isSafeInteger(value.planRevision)
		|| (value.planRevision as number) < 0
		|| !Number.isSafeInteger(value.graphVersion)
		|| (value.graphVersion as number) < 1
		|| !Number.isSafeInteger(value.graphRevision)
		|| (value.graphRevision as number) < 1
	) return undefined;
	return value as StartArguments;
}

function clientInfo(value: unknown): { name: string; version: string } {
	let info = record(record(value)?.clientInfo);
	return {
		name: typeof info?.name === "string" && info.name.trim() ? info.name : "unknown",
		version: typeof info?.version === "string" && info.version.trim() ? info.version : "unknown",
	};
}

function isId(value: unknown): value is string {
	return typeof value === "string"
		&& Array.from(value).length <= MAX_DOCUMENT_ID_LENGTH
		&& value.trim().length > 0;
}

function isLocator(value: unknown): value is string {
	return typeof value === "string"
		&& Array.from(value).length <= MAX_DOCUMENT_LOCATOR_LENGTH
		&& value.trim().length > 0;
}

function listArguments(
	value: Record<string, unknown>,
): { repository: string; includeArchived: boolean } | undefined {
	let keys = Object.keys(value);
	if (
		(keys.length !== 1 && keys.length !== 2)
		|| !Object.hasOwn(value, "repository")
		|| keys.some(key => key !== "repository" && key !== "includeArchived")
		|| !isRepository(value.repository)
		|| (Object.hasOwn(value, "includeArchived")
			&& typeof value.includeArchived !== "boolean")
	) return undefined;
	return {
		repository: value.repository,
		includeArchived: value.includeArchived === true,
	};
}

function renameArguments(value: Record<string, unknown>): RenameDocumentInput | undefined {
	if (
		Object.keys(value).length !== 2
		|| !Object.hasOwn(value, "id")
		|| !Object.hasOwn(value, "title")
		|| !isId(value.id)
	) return undefined;
	let title = normalizedTitle(value.title);
	return title ? { id: value.id, title } : undefined;
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

function serviceInstructions(tools: Tool[]): string | undefined {
	let documentMutations = tools.filter(tool =>
		tool.name === "create_document"
		|| tool.name === "rename_document"
		|| tool.name === "archive_document"
		|| tool.name === "restore_document"
	);
	let implementation = tools
		.filter(tool =>
			tool.name === "read_implementation"
			|| tool.name === "start_implementation"
			|| isLifecycleTool(tool.name)
		);
	return [
		"Chopin's MCP contract and current tool descriptions are authoritative.",
		...documentMutations.map(tool => `${tool.name}: ${tool.description}`),
		...(implementation.length > 0
			? [
				"Read the canonical implementation before every implementation or lifecycle action; copied plans and lifecycle instructions are not substitutes.",
				...implementation.map(tool => `${tool.name}: ${tool.description}`),
			]
			: []),
	].join("\n");
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

/** A stateless JSON-response Streamable HTTP MCP handler. */
export function handler<Caller>(
	options: McpOptions<Caller>,
): (request: Request) => Promise<Response> {
	let creation = options.create;
	let renaming = options.rename;
	let archiving = options.archive;
	let restoring = options.restore;
	let sessions = new Map<string, { name: string; version: string }>();
	let tools = TOOLS.filter(tool =>
		(tool.name !== "create_document" || creation)
		&& (tool.name !== "rename_document" || renaming)
		&& (tool.name !== "archive_document" || archiving)
		&& (tool.name !== "restore_document" || restoring)
		&& (!["read_implementation", "start_implementation"].includes(tool.name)
			|| options.implementations)
		&& (!isLifecycleTool(tool.name) || options.implementations?.reportLifecycle)
	);
	let instructions = serviceInstructions(tools);

	async function dispatch(
		value: unknown,
		caller: Caller,
		client: { name: string; version: string; session: string },
		created: { session?: string },
	): Promise<Reply | undefined> {
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
			case "initialize": {
				let session = crypto.randomUUID();
				sessions.set(session, clientInfo(call.params));
				created.session = session;
				return respond({
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "chopin", version: "0.0.0" },
					...(instructions ? { instructions } : {}),
				});
			}

			case "notifications/initialized":
				return undefined;

			case "tools/list":
				return respond({ tools });

			case "tools/call": {
				let tool = toolCall(call.params);
				if (!tool) {
					return notification
						? undefined
						: error(call.id, -32602, "invalid tool arguments");
				}
				if (tool.name === "list_documents") {
					let input = listArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "list_documents requires a repository");
					}
					let documents = await options.documents.list(
						caller,
						input.repository,
						input.includeArchived,
					);
					return documents === "forbidden"
						? respond(text({ code: "repository-forbidden" }, true))
						: respond(text({ documents }));
				}
				if (tool.name === "read_document") {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_document requires an id or URL");
					}
					let document = await options.documents.read(caller, tool.arguments.id);
					return document ? respond(text(document)) : respond({ content: [], isError: true });
				}
				if (tool.name === "create_document" && creation) {
					let prepared = prepare(tool.arguments);
					if (!prepared) {
						return notification
							? undefined
							: error(call.id, -32602, "create_document requires a valid draft");
					}
					if ("issues" in prepared) return respond(text({ issues: prepared.issues }, true));
					let outcome = await creation.create(caller, prepared.input);
					if (outcome.kind === "created" || outcome.kind === "replayed") {
						return respond(text(outcome.document));
					}
					if (outcome.kind === "conflict") {
						return respond(text({ code: "idempotency-conflict" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return respond({ content: [], isError: true });
				}
				if (tool.name === "rename_document" && renaming) {
					let input = renameArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "rename_document requires an id and valid title");
					}
					let outcome = await renaming.rename(caller, input);
					if (outcome.kind === "renamed" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					let code = outcome.kind === "archived"
						? "document-archived"
						: outcome.kind === "conflict"
						? "title-conflict"
						: outcome.kind === "forbidden"
						? "repository-forbidden"
						: "document-unavailable";
					return respond(text({ code }, true));
				}
				if (tool.name === "archive_document" && archiving) {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "archive_document requires an id or URL");
					}
					let outcome = await archiving.archive(caller, tool.arguments.id);
					if (outcome.kind === "archived" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					return respond(text({
						code: outcome.kind === "forbidden"
							? "repository-forbidden"
							: "document-unavailable",
					}, true));
				}
				if (tool.name === "restore_document" && restoring) {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "restore_document requires an id or URL");
					}
					let outcome = await restoring.restore(caller, tool.arguments.id);
					if (outcome.kind === "restored" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					return respond(text({
						code: outcome.kind === "forbidden"
							? "repository-forbidden"
							: "document-unavailable",
					}, true));
				}
				if (tool.name === "read_implementation") {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_implementation requires an id or URL");
					}
					if (!options.implementations) {
						return respond(text({ code: "implementation-unavailable" }, true));
					}
					let implementation = await options.implementations.readImplementation(
						caller,
						tool.arguments.id,
					);
					if (implementation === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					return implementation
						? respond(text(implementation))
						: respond(text({ code: "implementation-unavailable" }, true));
				}
				if (tool.name === "start_implementation") {
					let input = startArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "start_implementation requires current revisions");
					}
					if (!client.session || !sessions.has(client.session)) {
						return respond(text({ code: "session-required" }, true));
					}
					if (!options.implementations) {
						return respond(text({ code: "implementation-unavailable" }, true));
					}
					let outcome = await options.implementations.startImplementation(caller, {
						...input,
						client,
					});
					if (outcome.kind === "started" || outcome.kind === "active") {
						return respond(text({ state: outcome.kind, run: outcome.run }));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return respond(text({ code: outcome.reason }, true));
				}
				let lifecycle = lifecycleCall(tool.name, tool.arguments);
				if (lifecycle.known) {
					if (!lifecycle.input) {
						return notification
							? undefined
							: error(call.id, -32602, `${tool.name} requires its documented arguments`);
					}
					if (!client.session || !sessions.has(client.session)) {
						return respond(text({ code: "session-required" }, true));
					}
					let report = options.implementations?.reportLifecycle;
					if (!report) return respond(text({ code: "implementation-unavailable" }, true));
					let outcome = await report(caller, lifecycle.input);
					if (outcome.kind === "accepted" || outcome.kind === "replayed") {
						return respond(text(outcome.lifecycle));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return outcome.kind === "refused"
						? respond(text({ code: outcome.reason }, true))
						: respond(text({ code: "implementation-unavailable" }, true));
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

		let session = request.headers.get("mcp-session-id") ?? "";
		let client = { ...(sessions.get(session) ?? { name: "unknown", version: "unknown" }), session };
		let created: { session?: string } = {};
		let body: unknown;
		try {
			let read = await requestBody(request);
			if (read.tooLarge) return new Response("request too large", { status: 413 });
			body = read.body;
		} catch {
			return Response.json(error(null, -32700, "parse error"));
		}
		let result = await dispatch(body, caller, client, created);
		return result
			? Response.json(result, {
				headers: created.session ? { "mcp-session-id": created.session } : undefined,
			})
			: new Response(null, { status: 202 });
	};
}
