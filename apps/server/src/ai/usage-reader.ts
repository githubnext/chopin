import type { AiTokenCounts } from "../storage/model";

/** The most of one server-sent event read; a larger one is passed on and skipped. */
const MAX_EVENT = 4 * 1024 * 1024;
const MAX_MODEL = 200;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

type Json = Record<string, unknown>;

/**
 * The fields of a JSON answer that say its usage and error, by the object they are in: the answer
 * itself (`""`), or its `response` or `message`.
 */
const WANTED = new Map<string, readonly string[]>([
	["", ["usage", "error", "type"]],
	["response", ["usage", "error"]],
	["message", ["usage"]],
]);
/** The most of one wanted field kept; a larger one is skipped. */
const MAX_FIELD = 64 * 1024;
/** No wanted name is longer, so a longer key is not kept. */
const MAX_KEY = 16;
const STRING_STOP = /["\\]/g;
const STRUCTURE = /["{}[\]]/g;

type Frame = { array: boolean; name: string | undefined; key: string | undefined };
type Field = {
	path: string;
	depth: number;
	kind: "string" | "literal" | "container";
	text: string;
	long: boolean;
};

/**
 * Keeps the text of the wanted fields of a JSON answer as it passes, however large the answer:
 * everything else is scanned for its structure and let go.
 */
class JsonFields {
	#stack: Frame[] = [];
	#string = false;
	#escaped = false;
	#key: string | undefined;
	#expectKey = false;
	#valueNext = true;
	#field: Field | undefined;
	#fields = new Map<string, string>();
	#closed = false;

	push(text: string): void {
		let at = 0;
		while (at < text.length) {
			if (this.#unwanted()) {
				at = this.#skip(text, at);
			} else {
				this.#char(text[at]!);
				at++;
			}
		}
	}

	/** The wanted fields, in the shape of the answer, once its outermost object has closed. */
	found(): Json | undefined {
		if (!this.#closed) return undefined;
		let parsed = (path: string): unknown => {
			let text = this.#fields.get(path);
			if (text === undefined) return undefined;
			try {
				return JSON.parse(text);
			} catch {
				return undefined;
			}
		};
		return {
			usage: parsed("usage"),
			error: parsed("error"),
			type: parsed("type"),
			response: { usage: parsed("response.usage"), error: parsed("response.error") },
			message: { usage: parsed("message.usage") },
		};
	}

	#char(c: string): void {
		if (this.#string) {
			this.#keep(c);
			if (this.#escaped) {
				this.#escaped = false;
				this.#keyChar(c);
			} else if (c === "\\") {
				this.#escaped = true;
				this.#keyChar(c);
			} else if (c === '"') {
				this.#string = false;
				this.#stringEnded();
			} else {
				this.#keyChar(c);
			}
			return;
		}
		switch (c) {
			case '"': {
				let top = this.#stack.at(-1);
				if (top && !top.array && this.#expectKey) {
					this.#expectKey = false;
					this.#key = "";
				} else {
					this.#value("string");
				}
				this.#string = true;
				this.#keep(c);
				return;
			}
			case "{":
			case "[": {
				let parent = this.#stack.at(-1);
				this.#value("container");
				this.#keep(c);
				let name = c === "[" ? undefined : !parent
					? ""
					: !parent.array && parent.name === "" && parent.key && WANTED.has(parent.key)
					? parent.key
					: undefined;
				this.#stack.push({ array: c === "[", name, key: undefined });
				this.#expectKey = c === "{";
				this.#valueNext = c === "[";
				return;
			}
			case "}":
			case "]": {
				this.#literalEnded();
				this.#keep(c);
				this.#stack.pop();
				if (this.#stack.length === 0) this.#closed = true;
				let field = this.#field;
				if (field?.kind === "container" && field.depth === this.#stack.length) this.#fieldEnded();
				this.#expectKey = false;
				this.#valueNext = false;
				return;
			}
			case ":":
				this.#keep(c);
				this.#valueNext = true;
				return;
			case ",": {
				this.#literalEnded();
				this.#keep(c);
				let top = this.#stack.at(-1);
				if (top && !top.array) this.#expectKey = true;
				else this.#valueNext = true;
				return;
			}
			case " ":
			case "\t":
			case "\n":
			case "\r":
				this.#literalEnded();
				this.#keep(c);
				return;
			default:
				if (this.#valueNext) this.#value("literal");
				this.#keep(c);
		}
	}

	/** Whether the scan is inside a value none of whose keys or text can be wanted. */
	#unwanted(): boolean {
		return !this.#field && this.#key === undefined && this.#stack.at(-1)?.name === undefined
			&& this.#stack.length > 0;
	}

	/** Passes over unwanted text from `at` to the next character that changes the structure. */
	#skip(text: string, at: number): number {
		if (this.#string) {
			if (this.#escaped) {
				this.#escaped = false;
				return at + 1;
			}
			STRING_STOP.lastIndex = at;
			let stop = STRING_STOP.exec(text);
			if (!stop) return text.length;
			if (stop[0] === "\\") this.#escaped = true;
			else this.#string = false;
			return stop.index + 1;
		}
		STRUCTURE.lastIndex = at;
		let stop = STRUCTURE.exec(text);
		if (!stop) return text.length;
		if (stop[0] === '"') this.#string = true;
		else this.#char(stop[0]);
		return stop.index + 1;
	}

	#keyChar(c: string): void {
		if (this.#key !== undefined && this.#key.length <= MAX_KEY) this.#key += c;
	}

	#stringEnded(): void {
		if (this.#key !== undefined) {
			let top = this.#stack.at(-1);
			if (top) top.key = this.#key.length <= MAX_KEY ? this.#key : undefined;
			this.#key = undefined;
			return;
		}
		let field = this.#field;
		if (field?.kind === "string" && field.depth === this.#stack.length) this.#fieldEnded();
	}

	#literalEnded(): void {
		let field = this.#field;
		if (field?.kind === "literal" && field.depth === this.#stack.length) this.#fieldEnded();
	}

	#value(kind: Field["kind"]): void {
		if (!this.#valueNext) return;
		this.#valueNext = false;
		let top = this.#stack.at(-1);
		if (this.#field || !top || top.array || top.name === undefined || !top.key) return;
		if (!WANTED.get(top.name)?.includes(top.key)) return;
		this.#field = {
			path: top.name ? `${top.name}.${top.key}` : top.key,
			depth: this.#stack.length,
			kind,
			text: "",
			long: false,
		};
	}

	#keep(c: string): void {
		let field = this.#field;
		if (!field || field.long) return;
		if (field.text.length < MAX_FIELD) field.text += c;
		else field.long = true;
	}

	#fieldEnded(): void {
		let field = this.#field!;
		this.#field = undefined;
		if (!field.long) this.#fields.set(field.path, field.text);
	}
}

function object(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The model a request body names in its `model` field, when it is JSON and names one that can be
 * shown: printable, without line breaks, and at most 200 characters.
 */
export function requestedModel(body: Uint8Array | undefined): string | undefined {
	if (!body?.length) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}
	let model = object(parsed)?.model;
	if (typeof model !== "string") return undefined;
	let trimmed = model.trim();
	if (!trimmed || trimmed.length > MAX_MODEL || /\p{Cc}/u.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

/**
 * The token counts in one `usage` object, in any of the shapes the proxied providers report:
 * OpenAI's chat completions and embeddings (`prompt_tokens`, `completion_tokens`), its Responses
 * API (`input_tokens`, `output_tokens`), each with the cached part of the input in its details,
 * and Anthropic's Messages API, whose cache reads and writes are counted apart from its input. The
 * input is always what was read without the cache, so a cached part is taken out of OpenAI's.
 */
export function usageTokens(value: unknown): AiTokenCounts | undefined {
	let usage = object(value);
	if (!usage) return undefined;
	let input = count(usage.input_tokens) ?? count(usage.prompt_tokens);
	let output = count(usage.output_tokens) ?? count(usage.completion_tokens);
	let cached = count(object(usage.prompt_tokens_details)?.cached_tokens)
		?? count(object(usage.input_tokens_details)?.cached_tokens);
	let cacheRead = count(usage.cache_read_input_tokens) ?? cached;
	let cacheWrite = count(usage.cache_creation_input_tokens);
	let tokens: AiTokenCounts = {
		...(input !== undefined
			? { input: cached !== undefined ? Math.max(0, input - cached) : input }
			: {}),
		...(output !== undefined ? { output } : {}),
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
	return Object.keys(tokens).length ? tokens : undefined;
}

/** A provider's error code in an answer or event: `error.code`, else `error.type`. */
function errorCode(value: Json): string | undefined {
	let error = object(value.error) ?? object(object(value.response)?.error);
	if (!error && value.type !== "error") return undefined;
	let code = [error?.code, error?.type].find(
		candidate => typeof candidate === "string" && ERROR_CODE.test(candidate),
	);
	return typeof code === "string" ? code : "provider-error";
}

/**
 * Reads the token counts and any error a provider reports in its answer as it passes, without
 * holding it back: a JSON body's usage and error once it has all come, however large it is, or each
 * event of a server-sent event stream,
 * in which a later count replaces an earlier one (Anthropic sends its output count again as it
 * grows, OpenAI its usage in the last event).
 */
export class UsageReader {
	readonly #stream: boolean;
	readonly #decoder = new TextDecoder();
	readonly #json = new JsonFields();
	#line = "";
	#skipping = false;
	#data: string[] = [];
	#dataSize = 0;
	#tokens: AiTokenCounts = {};
	#error: string | undefined;

	constructor(contentType: string | null) {
		this.#stream = /^\s*text\/event-stream\b/i.test(contentType ?? "");
	}

	push(bytes: Uint8Array): void {
		let text = this.#decoder.decode(bytes, { stream: true });
		if (this.#stream) this.#lines(text);
		else this.#json.push(text);
	}

	/** What was read once the answer has ended. */
	end(): { tokens: AiTokenCounts; error?: string } {
		if (this.#stream) {
			this.#lines(`${this.#decoder.decode()}\n\n`);
		} else {
			this.#json.push(this.#decoder.decode());
			let found = this.#json.found();
			if (found) this.#take(found);
		}
		return { tokens: this.#tokens, ...(this.#error ? { error: this.#error } : {}) };
	}

	#lines(text: string): void {
		let start = 0;
		for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", start)) {
			let line = this.#skipping ? "" : this.#line + text.slice(start, at);
			let skipped = this.#skipping;
			this.#line = "";
			this.#skipping = false;
			start = at + 1;
			if (!skipped) this.#field(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
		if (this.#skipping) return;
		this.#line += text.slice(start);
		if (this.#line.length > MAX_EVENT) {
			this.#line = "";
			this.#skipping = true;
		}
	}

	#field(line: string): void {
		if (line === "") {
			let data = this.#data.join("\n");
			this.#data = [];
			this.#dataSize = 0;
			if (data && data !== "[DONE]") this.#read(data);
			return;
		}
		if (!line.startsWith("data:")) return;
		let value = line.slice(line.startsWith("data: ") ? 6 : 5);
		this.#dataSize += value.length;
		if (this.#dataSize > MAX_EVENT) {
			this.#data = [];
			return;
		}
		this.#data.push(value);
	}

	#read(text: string): void {
		let parsed: Json | undefined;
		try {
			parsed = object(JSON.parse(text));
		} catch {
			return;
		}
		if (parsed) this.#take(parsed);
	}

	#take(parsed: Json): void {
		let error = errorCode(parsed);
		if (error) this.#error = error;
		for (
			let usage of [
				parsed.usage,
				object(parsed.response)?.usage,
				object(parsed.message)?.usage,
			]
		) {
			let tokens = usageTokens(usage);
			if (tokens) this.#tokens = { ...this.#tokens, ...tokens };
		}
	}
}
