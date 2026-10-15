import { z } from "zod";

/**
 * The agent connection version this package speaks. A client states it in `attach`, and it is
 * the number in `AGENT_SUBPROTOCOL`.
 */
export const AGENT_VERSION = 1;

/** Where a Chopin server accepts agent connections. */
export const AGENT_PATH = "/api/v1/agent";

/**
 * The WebSocket subprotocol a client must offer and the server echoes. A breaking change to the
 * messages gets a new one, `chopin.agent.v2`, rather than changing this one.
 */
export const AGENT_SUBPROTOCOL = "chopin.agent.v1";

/** The largest message either side may send, in UTF-8 bytes. */
export const MAX_LINK_MESSAGE_BYTES = 2 * 1024 * 1024;

/** WebSocket close codes a Chopin server uses to end a link. */
export const LINK_CLOSE = {
	detached: 1000,
	/** The client answered no protocol ping for the server's timeout. */
	unresponsive: 1001,
	malformed: 1008,
	tooLarge: 1009,
	failed: 1011,
	unauthorized: 4401,
	forbidden: 4403,
	unavailable: 4404,
	attached: 4409,
	unsupportedVersion: 4426,
} as const;

/** The longest `message`, error, title or question text, in UTF-16 code units. */
export const MAX_LINK_NOTE_LENGTH = 4_000;

const MAX_ID = 128;
const MAX_NAME = 128;
const MAX_NOTE = MAX_LINK_NOTE_LENGTH;
const MAX_TOOLS = 256;
const MAX_RUNS = 64;
const MAX_STAGES = 64;
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;

const id = z.string().min(1).max(MAX_ID);
const name = z.string().min(1).max(MAX_NAME);
const note = z.string().max(MAX_NOTE);
const text = z.string().max(MAX_LINK_MESSAGE_BYTES);
const count = z.number().int().nonnegative();
const seconds = z.number().int().nonnegative();
const json = z.json();

const finishReason = z.strictObject({
	unified: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]),
	raw: z.string().max(MAX_NAME).optional(),
});

const usage = z.strictObject({
	inputTokens: z.strictObject({
		total: count.optional(),
		noCache: count.optional(),
		cacheRead: count.optional(),
		cacheWrite: count.optional(),
	}),
	outputTokens: z.strictObject({
		total: count.optional(),
		text: count.optional(),
		reasoning: count.optional(),
	}),
});

/**
 * The stream parts a client may send for a turn: `HarnessV1StreamPart`s
 * without metadata. A `tool-call` here is always one of the client's own tools;
 * Chopin's host tools are called with `host-tool-call` instead.
 */
export const streamPartSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("stream-start"), modelId: name.optional() }),
	z.strictObject({ type: z.literal("text-start"), id }),
	z.strictObject({ type: z.literal("text-delta"), id, delta: text }),
	z.strictObject({ type: z.literal("text-end"), id }),
	z.strictObject({ type: z.literal("reasoning-start"), id }),
	z.strictObject({ type: z.literal("reasoning-delta"), id, delta: text }),
	z.strictObject({ type: z.literal("reasoning-end"), id }),
	z.strictObject({
		type: z.literal("tool-input-start"),
		id,
		toolName: name,
		providerExecuted: z.boolean().optional(),
		dynamic: z.boolean().optional(),
		title: note.optional(),
	}),
	z.strictObject({ type: z.literal("tool-input-delta"), id, delta: text }),
	z.strictObject({ type: z.literal("tool-input-end"), id }),
	z.strictObject({
		type: z.literal("tool-call"),
		toolCallId: id,
		toolName: name,
		input: text,
		providerExecuted: z.literal(true),
		dynamic: z.boolean().optional(),
	}),
	z.strictObject({
		type: z.literal("tool-result"),
		toolCallId: id,
		toolName: name,
		result: json,
		isError: z.boolean().optional(),
		preliminary: z.boolean().optional(),
		dynamic: z.boolean().optional(),
	}),
	z.strictObject({ type: z.literal("finish-step"), finishReason, usage }),
	z.strictObject({ type: z.literal("finish"), finishReason, totalUsage: usage }),
	z.strictObject({ type: z.literal("error"), error: note }),
]);

/** A plain identifier: no spaces, quotes, `:` or `=`, so it cannot hold an assignment. */
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/**
 * The structured error a failed `tool-result` may carry as its `result`, either
 * as this object or as its JSON text. `code` is a stable machine identifier,
 * `kind` an optional display name, and `message` human-readable text. `code`
 * and `kind` are plain identifiers: an ASCII letter or digit, then up to 127
 * letters, digits, `.`, `_` or `-`. Chopin still accepts any JSON as a result;
 * this is a recognised convention.
 */
export const toolErrorSchema = z.strictObject({
	error: z.strictObject({
		code: identifier,
		kind: identifier.optional(),
		message: note.min(1),
	}),
});

const option = z.strictObject({
	label: z.string().max(MAX_NOTE),
	description: z.string().max(MAX_NOTE),
	preview: z.string().max(MAX_NOTE * 4).optional(),
});

/** Atomic's `ask_user_question` parameters, as a client's `HostInput` receives them. */
export const questionParamsSchema = z.strictObject({
	questions: z.array(z.strictObject({
		question: z.string().max(MAX_NOTE),
		header: z.string().max(MAX_NAME),
		options: z.array(option).max(MAX_OPTIONS),
		multiSelect: z.boolean().optional(),
	})).min(1).max(MAX_QUESTIONS),
});

/** One `HostInput` method call and its arguments. */
export const inputSchema = z.discriminatedUnion("method", [
	z.strictObject({ method: z.literal("questionnaire"), params: questionParamsSchema }),
	z.strictObject({ method: z.literal("confirm"), title: note, message: note }),
	z.strictObject({
		method: z.literal("select"),
		title: note,
		choices: z.array(z.string().max(MAX_NOTE)).max(MAX_OPTIONS),
	}),
	z.strictObject({ method: z.literal("input"), title: note, placeholder: note.optional() }),
	z.strictObject({ method: z.literal("editor"), title: note, initial: note.optional() }),
]);

const runStage = z.strictObject({
	id,
	name: z.string().max(MAX_NOTE),
	kind: z.literal("tool").optional(),
	status: z.enum([
		"pending",
		"running",
		"awaiting_input",
		"paused",
		"blocked",
		"completed",
		"failed",
		"skipped",
	]),
	started: seconds.optional(),
	ended: seconds.optional(),
});

/** A workflow run card, as Chat shows it. */
export const runSchema = z.strictObject({
	id,
	name: z.string().max(MAX_NOTE),
	status: z.enum(["running", "waiting", "paused", "finished", "blocked", "failed", "stopped"]),
	started: seconds,
	updated: seconds,
	ended: seconds.optional(),
	stages: z.array(runStage).max(MAX_STAGES),
	earlierStages: count.optional(),
	waiting: count,
});

const checkout = z.strictObject({
	origin: z.string().max(2_048).optional(),
	branch: z.string().max(256).optional(),
	head: z.string().max(MAX_ID).optional(),
});

/** Every message a client sends. */
export const clientMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("attach"),
		version: z.number().int(),
		document: z.string().min(1).max(2_048),
		checkout: checkout.optional(),
	}),
	z.strictObject({ type: z.literal("started"), session: id }),
	z.strictObject({ type: z.literal("start-failed"), session: id, message: note }),
	z.strictObject({
		type: z.literal("tools"),
		session: id,
		turn: id,
		names: z.array(name).max(MAX_TOOLS),
	}),
	z.strictObject({ type: z.literal("part"), session: id, turn: id, part: streamPartSchema }),
	z.strictObject({
		type: z.literal("host-tool-call"),
		session: id,
		turn: id,
		toolCallId: id,
		toolName: name,
		input: text,
	}),
	z.strictObject({
		type: z.literal("turn-end"),
		session: id,
		turn: id,
		status: z.enum(["finished", "failed", "aborted"]),
		message: note.optional(),
	}),
	z.strictObject({
		type: z.literal("input-request"),
		request: id,
		session: id,
		workflowRunId: id.optional(),
		workflowStageId: id.optional(),
		rootRunId: id.optional(),
		input: inputSchema,
	}),
	z.strictObject({ type: z.literal("input-cancel"), request: id }),
	z.strictObject({
		type: z.literal("runs"),
		session: id,
		active: z.array(id).max(MAX_RUNS),
		paused: z.array(id).max(MAX_RUNS),
		cards: z.array(runSchema).max(MAX_RUNS),
	}),
	z.strictObject({
		type: z.literal("control-result"),
		request: id,
		ok: z.boolean(),
		message: note.optional(),
	}),
	z.strictObject({ type: z.literal("detach") }),
]);

const toolSpec = z.strictObject({
	name,
	description: z.string().max(64_000).optional(),
	inputSchema: z.record(z.string(), json).optional(),
});

const responseFormat = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("text") }),
	z.strictObject({
		type: z.literal("json"),
		schema: z.record(z.string(), json).optional(),
		name: name.optional(),
		description: note.optional(),
	}),
]);

/** Why a server refused an attach. */
export const refusalCodeSchema = z.enum([
	"unsupported-version",
	"repository-forbidden",
	"document-unavailable",
	"document-archived",
	"access-revoked",
	"planner-attached",
	"sign-in-required",
	"unavailable",
]);

/** Every message a server sends. */
export const serverMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("attached"),
		version: z.number().int(),
		document: z.strictObject({
			id,
			title: z.string().max(MAX_NOTE),
			repository: z.string().max(2 * MAX_NAME + 1),
			url: z.string().max(2_048).optional(),
		}),
	}),
	z.strictObject({ type: z.literal("refused"), code: refusalCodeSchema, message: note }),
	z.strictObject({
		type: z.literal("error"),
		code: z.enum(["malformed-message", "message-too-large", "protocol"]),
		message: note,
	}),
	z.strictObject({
		type: z.literal("start"),
		session: id,
		mode: z.enum(["planner", "isolated"]),
	}),
	z.strictObject({
		type: z.literal("turn"),
		session: id,
		turn: id,
		prompt: text,
		instructions: text.optional(),
		model: z.string().max(MAX_NOTE).optional(),
		tools: z.array(toolSpec).max(MAX_TOOLS),
		responseFormat: responseFormat.optional(),
	}),
	z.strictObject({ type: z.literal("abort"), session: id, turn: id }),
	z.strictObject({
		type: z.literal("host-tool-result"),
		session: id,
		turn: id,
		toolCallId: id,
		output: json,
		isError: z.boolean().optional(),
	}),
	z.strictObject({
		type: z.literal("input-result"),
		request: id,
		status: z.enum(["answered", "expired", "cancelled", "failed"]),
		value: json.optional(),
		message: note.optional(),
	}),
	z.strictObject({ type: z.literal("stop"), request: id, session: id, run: id.optional() }),
	z.strictObject({ type: z.literal("resume"), request: id, session: id, run: id.optional() }),
	z.strictObject({ type: z.literal("destroy"), session: id }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type StreamPart = z.infer<typeof streamPartSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
export type InputCall = z.infer<typeof inputSchema>;
export type InputMethod = InputCall["method"];
export type LinkRun = z.infer<typeof runSchema>;
export type RefusalCode = z.infer<typeof refusalCodeSchema>;
export type ProtocolErrorCode = Extract<ServerMessage, { type: "error" }>["code"];
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export type Parsed<T> =
	| { ok: true; message: T }
	| { ok: false; code: Exclude<ProtocolErrorCode, "protocol">; message: string };

/** Whether a string's UTF-8 encoding exceeds the limit, encoding only when it might. */
function oversized(value: string): boolean {
	return value.length * 3 > MAX_LINK_MESSAGE_BYTES
		&& new TextEncoder().encode(value).byteLength > MAX_LINK_MESSAGE_BYTES;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
	if (typeof raw !== "string") {
		return { ok: false, code: "malformed-message", message: "Messages are JSON text frames." };
	}
	if (oversized(raw)) {
		return {
			ok: false,
			code: "message-too-large",
			message: `Messages are limited to ${MAX_LINK_MESSAGE_BYTES} bytes.`,
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, code: "malformed-message", message: "The message is not JSON." };
	}
	let result: ReturnType<typeof schema.safeParse>;
	try {
		result = schema.safeParse(value);
	} catch {
		return { ok: false, code: "malformed-message", message: "The message is nested too deeply." };
	}
	if (result.success) return { ok: true, message: result.data };
	let issue = result.error.issues[0];
	let path = issue?.path.join(".") || "message";
	return {
		ok: false,
		code: "malformed-message",
		message: `Invalid ${path}: ${issue?.message ?? "unknown"}`.slice(0, MAX_NOTE),
	};
}

export function parseClientMessage(raw: unknown): Parsed<ClientMessage> {
	return parse(clientMessageSchema, raw);
}

export function parseServerMessage(raw: unknown): Parsed<ServerMessage> {
	return parse(serverMessageSchema, raw);
}

/** The message as one text frame, or undefined when it would exceed the limit. */
export function encodeMessage(message: ClientMessage | ServerMessage): string | undefined {
	let encoded = JSON.stringify(message);
	return oversized(encoded) ? undefined : encoded;
}
