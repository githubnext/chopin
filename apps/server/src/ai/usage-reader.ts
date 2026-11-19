import type { AiTokenCounts } from "../storage/model";

/** The most of a JSON answer read for its token counts; a larger one is passed on uncounted. */
const MAX_JSON = 16 * 1024 * 1024;
/** The most of one server-sent event read; a larger one is passed on and skipped. */
const MAX_EVENT = 4 * 1024 * 1024;
const MAX_MODEL = 200;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

type Json = Record<string, unknown>;

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
 * holding it back: a JSON body once it has all come, or each event of a server-sent event stream,
 * in which a later count replaces an earlier one (Anthropic sends its output count again as it
 * grows, OpenAI its usage in the last event).
 */
export class UsageReader {
	readonly #stream: boolean;
	readonly #decoder = new TextDecoder();
	#chunks: Uint8Array[] = [];
	#size = 0;
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
		if (!this.#stream) {
			this.#size += bytes.byteLength;
			if (this.#size <= MAX_JSON) this.#chunks.push(bytes.slice());
			else this.#chunks = [];
			return;
		}
		this.#lines(this.#decoder.decode(bytes, { stream: true }));
	}

	/** What was read once the answer has ended. */
	end(): { tokens: AiTokenCounts; error?: string } {
		if (this.#stream) {
			this.#lines(`${this.#decoder.decode()}\n\n`);
		} else if (this.#size > 0 && this.#size <= MAX_JSON) {
			let body = new Uint8Array(this.#size);
			let offset = 0;
			for (let chunk of this.#chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			this.#chunks = [];
			this.#read(this.#decoder.decode(body));
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
		if (!parsed) return;
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
