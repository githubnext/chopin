import { AI_LAUNCH_HEADER, AI_PROXY_PATH, isAiProvider } from "@chopin/protocol/ai-credentials";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { AiCredentialRecord } from "../storage/model";
import type { AiAdmitted, AiCredentials, AiDeadlines, AiRefusal } from "./credentials";
import type { AiAttemptRecord, AiUsage } from "./usage";

/**
 * A send the transport took: the credential it carries, the person's stored credential that is,
 * as it was read, and the provider's answer to come.
 */
type Handed = { secret: string; record: AiCredentialRecord; upstream: Promise<Response> };

/**
 * What submits a request to its provider. It is handed the deadlines the request must come before,
 * reads its clock as it takes the request, and takes it only before both: otherwise it says which
 * came first (`late`), and sends nothing. A send it takes says when (`at`).
 */
export type AiTransport = (
	target: URL,
	init: RequestInit,
	deadlines: AiDeadlines,
) => AiAdmitted<Promise<Response>>;

/** The transport that submits with `send`, deciding on `clock`'s reading as it is entered. */
export function aiTransport(send: typeof fetch, clock: () => number): AiTransport {
	return (target, init, deadlines) => {
		let at = clock();
		if (at >= deadlines.launch) return { late: "launch" };
		if (deadlines.token !== undefined && at >= deadlines.token) return { late: "token" };
		return { sent: (async () => send(target, init))(), at };
	};
}

/** Each provider's own API origin, the only host the proxy sends its credential to. */
export const AI_UPSTREAMS: Record<AiProvider, string> = {
	"github-copilot": "https://api.githubcopilot.com",
	openai: "https://api.openai.com",
	anthropic: "https://api.anthropic.com",
};

/** The public model catalog agents refresh their model lists from. */
export const MODEL_CATALOG = "https://models.dev";
/** The catalog's route under the proxy, for an agent's catalog base URL. */
export const MODEL_CATALOG_PATH = `${AI_PROXY_PATH}/models.dev`;

/** Where each provider takes its key; the proxy puts the real one there and nowhere else. */
const CREDENTIAL_HEADER: Record<AiProvider, "authorization" | "x-api-key"> = {
	"github-copilot": "authorization",
	openai: "authorization",
	anthropic: "x-api-key",
};

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]*";

/**
 * The model API routes the proxy serves for each provider, by method, relative to the provider's
 * route: listing models and asking for completions or messages, nothing else on that host. A path
 * with an empty, dot or percent-encoded segment matches none.
 */
const ROUTES: Record<AiProvider, Array<{ methods: readonly string[]; path: RegExp }>> = {
	"github-copilot": [
		{ methods: ["GET"], path: /^\/models$/ },
		{ methods: ["POST"], path: new RegExp(`^/models/${SEGMENT}/policy$`) },
		{ methods: ["POST"], path: /^\/(?:chat\/completions|responses|embeddings)$/ },
		{ methods: ["POST"], path: /^\/v1\/(?:messages(?:\/count_tokens)?|systemone)$/ },
	],
	openai: [
		{ methods: ["GET"], path: new RegExp(`^/v1/models(?:/${SEGMENT})?$`) },
		{ methods: ["GET", "POST"], path: new RegExp(`^/v1/responses(?:/${SEGMENT}){0,2}$`) },
		{ methods: ["POST"], path: /^\/v1\/(?:chat\/completions|completions|embeddings)$/ },
	],
	anthropic: [
		{ methods: ["GET"], path: new RegExp(`^/v1/models(?:/${SEGMENT})?$`) },
		{ methods: ["POST"], path: /^\/v1\/(?:messages(?:\/count_tokens)?|complete)$/ },
	],
};

/** What the proxy sends back in place of the credential, should a provider echo it. */
const REDACTED_TEXT = "[redacted]";
const REDACTED = new TextEncoder().encode(REDACTED_TEXT);

/** The largest request body the proxy forwards: well past any model request with images. */
const MAX_BODY = 64 * 1024 * 1024;
const CATALOG_FRESH_MS = 10 * 60 * 1000;

/** Request headers never forwarded: a credential, the hop's own, and what names the caller. */
const DROPPED_REQUEST = new Set([
	"authorization",
	"x-api-key",
	AI_LAUNCH_HEADER,
	"proxy-authorization",
	"cookie",
	"host",
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-length",
	"accept-encoding",
	"forwarded",
	"x-real-ip",
	"origin",
	"referer",
]);
/**
 * The only response headers passed back, by name or by prefix: what model clients read to parse an
 * answer, retry, follow rate limits and name a request. Every other header (cookies, the upstream
 * hop's own, anything a provider adds) is left out.
 */
const RETURNED_RESPONSE = new Set([
	"content-type",
	"cache-control",
	"etag",
	"last-modified",
	"location",
	"retry-after",
	"retry-after-ms",
	"x-should-retry",
	"x-request-id",
	"request-id",
	"x-github-request-id",
	"openai-processing-ms",
	"openai-version",
]);
const RETURNED_RESPONSE_PREFIXES = ["x-ratelimit-", "anthropic-ratelimit-"];
/**
 * How each provider whose key a person gives Chopin says, in a 401's body, that the key itself is
 * invalid, which no retry changes: OpenAI's `invalid_api_key`, Anthropic's `authentication_error`.
 * A rate limit, or a refusal of one model, says nothing about the key.
 */
const KEY_REFUSED: Partial<Record<AiProvider, (body: unknown) => boolean>> = {
	openai: body =>
		(body as { error?: { code?: unknown } } | null)?.error?.code === "invalid_api_key",
	anthropic: body =>
		(body as { error?: { type?: unknown } } | null)?.error?.type === "authentication_error",
};
/** The largest refusal body read for what it says about the key. */
const MAX_REFUSAL = 64 * 1024;

/** The content codings `fetch` decodes, so the proxy reads the body it passes back. */
const DECODED = new Set(["identity", "gzip", "x-gzip", "deflate", "br", "zstd"]);

const REFUSALS: Record<AiRefusal, { status: number; message: string }> = {
	"no-placeholder": {
		status: 401,
		message: "Send the key Chopin gave this launch in Authorization or x-api-key.",
	},
	"no-launch": {
		status: 401,
		message: `Send this launch's own credential in ${AI_LAUNCH_HEADER}.`,
	},
	"unknown-placeholder": { status: 401, message: "Chopin doesn't know this key." },
	"other-provider": { status: 401, message: "This key is for another provider." },
	"other-launch": { status: 401, message: "This key was given to another launch." },
	"launch-ended": { status: 401, message: "The launch this key was given to has ended." },
	"not-connected": {
		status: 403,
		message: "This provider is no longer connected in Chopin. Connect it again in Chopin.",
	},
	"credential-changed": {
		status: 409,
		message:
			"This provider's credential changed in Chopin while this request was sent. Send it again.",
	},
	"sign-in-unavailable": {
		status: 403,
		message: "Chopin can't read your GitHub sign-in now. Sign in to Chopin again.",
	},
	"no-copilot-access": {
		status: 403,
		message: "Your GitHub account has no Copilot subscription.",
	},
	"copilot-unavailable": {
		status: 502,
		message: "GitHub can't give a Copilot token now. Try again in a moment.",
	},
	cancelled: { status: 499, message: "The request was cancelled." },
	restarting: {
		status: 503,
		message: "Chopin is restarting, so this wasn't sent. Send it again in a moment.",
	},
	busy: {
		status: 503,
		message: "Launches or credentials kept changing in Chopin while this was sent. Send it again.",
	},
};

export type AiProxyOptions = {
	credentials: AiCredentials;
	/** Each provider's origin, and the catalog's; tests point them at fakes. */
	upstreams?: Partial<Record<AiProvider, string>> & { catalog?: string };
	fetch?: typeof fetch;
	/**
	 * The clock the default transport reads as it takes a send, against a launch's and a Copilot
	 * token's deadlines, and the catalog's age is told by; the credentials' own unless given.
	 */
	clock?: () => number;
	/** What submits a model request; `fetch` on `clock` (`aiTransport`) unless given. */
	transport?: AiTransport;
	/**
	 * Where each request sent to a provider is recorded before it is sent and completed when its
	 * answer ends; without it nothing is recorded.
	 */
	usage?: AiUsage;
};

function failure(status: number, message: string, code: string): Response {
	return Response.json({ error: { message, type: "chopin_proxy", code } }, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

function refused(reason: AiRefusal): Response {
	let refusal = REFUSALS[reason];
	return failure(refusal.status, refusal.message, reason);
}

/** The one value the request carries as its key, from `Authorization: Bearer` or `x-api-key`. */
function presented(request: Request): string | undefined | null {
	let values = new Set<string>();
	let authorization = request.headers.get("authorization");
	if (authorization) {
		let match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
		if (!match) return null;
		values.add(match[1]!);
	}
	let apiKey = request.headers.get("x-api-key")?.trim();
	if (apiKey) values.add(apiKey);
	if (values.size > 1) return null;
	return [...values][0];
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
	let declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_BODY) return undefined;
	if (!request.body) return new Uint8Array();
	let chunks: Uint8Array[] = [];
	let total = 0;
	let reader = request.body.getReader();
	while (true) {
		let { done, value } = await reader.read();
		if (done || !value) break;
		total += value.byteLength;
		if (total > MAX_BODY) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	let body = new Uint8Array(total);
	let offset = 0;
	for (let chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function dropped(name: string): boolean {
	return DROPPED_REQUEST.has(name) || name.startsWith("x-forwarded-");
}

function forwardedHeaders(request: Request): Headers {
	let headers = new Headers();
	for (let [name, value] of request.headers) {
		if (!dropped(name)) headers.append(name, value);
	}
	return headers;
}

/**
 * A launch's stand-in as Chopin hands it out (`chopin_ai_` and 43 base64url characters), in any
 * case, since a header's name is sent lowercased.
 */
const STAND_IN = /chopin_ai_[A-Za-z0-9_-]{43}/i;

/**
 * Whether a header the proxy does not send on (`discarded`), other than the two the key is taken
 * from, carries any launch's stand-in in its name or its value: sent without it, the request would
 * not be the one its agent sent.
 */
function standInDropped(request: Request, discarded: (name: string) => boolean): boolean {
	for (let [name, value] of request.headers) {
		if (name === "authorization" || name === "x-api-key" || !discarded(name)) continue;
		if (STAND_IN.test(name) || STAND_IN.test(value)) return true;
	}
	return false;
}

/**
 * What a query carries that the catalog can't be served with: a launch's stand-in in a name or a
 * value (`stand-in`), as it came or decoded, or a name or value that can't be decoded
 * (`unreadable`). Each is decoded on its own, so one that doesn't decode hides nothing in another.
 */
function queried(search: string): "stand-in" | "unreadable" | undefined {
	let found: "stand-in" | undefined;
	for (let field of search.replace(/^\?/, "").split("&")) {
		let equals = field.indexOf("=");
		for (let part of equals < 0 ? [field] : [field.slice(0, equals), field.slice(equals + 1)]) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(part.replaceAll("+", " "));
			} catch {
				return "unreadable";
			}
			if (STAND_IN.test(part) || STAND_IN.test(decoded)) found = "stand-in";
		}
	}
	return found;
}

function droppedStandIn(): Response {
	return failure(
		400,
		"This request also carries a key Chopin gave a launch in a header Chopin doesn't forward. Send the key only in Authorization or x-api-key.",
		"dropped-header",
	);
}

function routed(provider: AiProvider, method: string, path: string): boolean {
	return ROUTES[provider].some(route => route.methods.includes(method) && route.path.test(path));
}

/**
 * Whether a header, as it is emitted, holds `secret`: in its name, in any case (a name is sent
 * lowercased), or in its value.
 */
function holds(name: string, value: string, secret: string): boolean {
	return name.includes(secret.toLowerCase()) || value.includes(secret);
}

/**
 * The upstream's headers to pass back: only those `RETURNED_RESPONSE` names, each with `secret`
 * replaced wherever its value holds it, and `no-store` when the provider says nothing of caching.
 * What is emitted is checked, not what came: a name passed by its prefix that holds `secret`, in
 * any case, and a value whose replacement forms `secret` again with the text around it, are left
 * out. Last, the finished set, the `no-store` Chopin adds included, is checked again: when one of
 * Chopin's own would hold `secret`, there is no set to pass back (undefined), since the answer must
 * not go back without its protection from caching either.
 */
function returnedHeaders(upstream: Response, secret: string): Headers | undefined {
	let headers = new Headers({ "cache-control": "no-store" });
	for (let [name, value] of upstream.headers) {
		if (
			!RETURNED_RESPONSE.has(name)
			&& !RETURNED_RESPONSE_PREFIXES.some(prefix => name.startsWith(prefix))
		) continue;
		let emitted = value.replaceAll(secret, REDACTED_TEXT);
		if (holds(name, emitted, secret)) continue;
		headers.set(name, emitted);
	}
	for (let [name, value] of headers) if (holds(name, value, secret)) return undefined;
	return headers;
}

/**
 * A failure answered once the proxy holds `secret`, with every header of its own that would hold
 * it left out: the failure is no answer to keep, and carries nothing of the provider's.
 */
function failedHolding(secret: string, status: number, message: string, code: string): Response {
	let response = failure(status, message, code);
	let holding: string[] = [];
	for (let [name, value] of response.headers) if (holds(name, value, secret)) holding.push(name);
	for (let name of holding) response.headers.delete(name);
	return response;
}

/** `body` as JSON, or undefined when it isn't. */
function parsed(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}
}

/** Whether `fetch` decoded the upstream's body, so a credential in it can be found and replaced. */
function readable(upstream: Response): boolean {
	let encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
	return !encoding || DECODED.has(encoding);
}

/** `origin` with `path` and `search` from the request, never another host whatever the path says. */
function upstreamUrl(origin: string, path: string, search: string): URL {
	let target = new URL(origin);
	target.pathname = `${target.pathname.replace(/\/$/, "")}${
		path.startsWith("/") ? "" : "/"
	}${path}`;
	target.search = search;
	return target;
}

/** The length of the longest end of `bytes` that `secret` starts with. */
function partialMatch(bytes: Uint8Array, secret: Uint8Array): number {
	for (let length = Math.min(secret.length - 1, bytes.length); length > 0; length--) {
		let start = bytes.length - length;
		let matches = true;
		for (let index = 0; index < length && matches; index++) {
			matches = bytes[start + index] === secret[index];
		}
		if (matches) return length;
	}
	return 0;
}

function indexOf(bytes: Uint8Array, secret: Uint8Array, from: number): number {
	let last = bytes.length - secret.length;
	for (let start = from; start <= last; start++) {
		let index = 0;
		while (index < secret.length && bytes[start + index] === secret[index]) index++;
		if (index === secret.length) return start;
	}
	return -1;
}

function joined(left: Uint8Array, right: Uint8Array): Uint8Array {
	let bytes = new Uint8Array(left.length + right.length);
	bytes.set(left);
	bytes.set(right, left.length);
	return bytes;
}

/**
 * `body` with every occurrence of `secret` replaced, even one split across chunks. Only an end of a
 * chunk that could begin the secret waits for the next chunk, so a stream is not held back. What is
 * emitted is checked as well as what came, since the replacement and the text around it could form
 * the secret again, within a chunk or across two: an emitted end that could begin it waits for the
 * next bytes too, and a stream that would emit it ends there, erroring, with none of it emitted.
 */
function scrubbed(body: ReadableStream<Uint8Array>, secret: string): ReadableStream<Uint8Array> {
	let needle = new TextEncoder().encode(secret);
	let pending: Uint8Array = new Uint8Array();
	let held: Uint8Array = new Uint8Array();
	let emit = (
		bytes: Uint8Array,
		controller: TransformStreamDefaultController<Uint8Array>,
		last: boolean,
	) => {
		let out = joined(held, bytes);
		if (indexOf(out, needle, 0) >= 0) {
			held = new Uint8Array();
			controller.error(new Error("the answer would have carried the credential"));
			return;
		}
		let waiting = last ? 0 : partialMatch(out, needle);
		held = out.slice(out.length - waiting);
		if (out.length > waiting) controller.enqueue(out.subarray(0, out.length - waiting));
	};
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				let bytes = joined(pending, chunk);
				let parts: Uint8Array[] = [];
				let from = 0;
				for (let at = indexOf(bytes, needle, 0); at >= 0; at = indexOf(bytes, needle, from)) {
					parts.push(bytes.subarray(from, at), REDACTED);
					from = at + needle.length;
				}
				let rest = bytes.subarray(from);
				let waiting = partialMatch(rest, needle);
				parts.push(rest.subarray(0, rest.length - waiting));
				pending = rest.slice(rest.length - waiting);
				emit(parts.reduce(joined, new Uint8Array()), controller, false);
			},
			flush(controller) {
				emit(pending, controller, true);
			},
		}),
	);
}

type CachedCatalog = { body: Uint8Array; headers: Headers; fetchedAt: number };

/**
 * Chopin's AI credential proxy, served at `/api/v1/ai/<provider>/...`, for the provider's model
 * API routes alone (`ROUTES`). A request must carry, in `Authorization: Bearer` or `x-api-key`, a
 * placeholder a live launch was handed for that provider, and in `AI_LAUNCH_HEADER` the credential
 * of that same launch, which its runner adds. The proxy drops these headers, reads the body, takes
 * a fresh Copilot token for one that expired meanwhile, and at the final handoff, in the same step
 * as the send, checks the launch is still live and the person's credential unchanged; the
 * transport is handed the launch's and the token's deadlines and checks them on the clock reading
 * it takes the request at. It puts
 * the real credential of the launch's person in the one header the provider takes it in, and sends
 * the request, path, query and body unchanged, to the provider's own origin and nowhere else: a
 * request with any launch's placeholder in a header the proxy drops, in its name or its value, is
 * refused, one anywhere else in the request is sent on as it is, and a redirect comes back to the
 * agent rather than being followed with the credential. The answer carries the provider's status
 * code, never its reason phrase, and only allow-listed headers; a credential the provider echoes
 * is taken out of them and the body, a body the proxy can't decode is refused, and so is an answer
 * a header Chopin adds would carry the credential in. A 401 that says the key itself is invalid
 * marks that key so no later launch is given it. `/api/v1/ai/models.dev/api.json` serves the
 * public model catalog, held for ten minutes, to a request carrying a live launch's credential
 * alone, and is fetched with no credential, so a placeholder in its query or another header, and a
 * query field that can't be decoded, is refused.
 */
export function aiProxy(options: AiProxyOptions) {
	let send = options.fetch ?? fetch;
	let clock = options.clock ?? (() => options.credentials.now());
	let transport = options.transport ?? aiTransport(send, clock);
	let catalog: CachedCatalog | undefined;

	let serveCatalog = async (request: Request, url: URL, path: string): Promise<Response> => {
		if (path !== "/api.json") return failure(404, "Only the catalog is served here.", "not-found");
		if (request.method !== "GET" && request.method !== "HEAD") {
			return failure(405, "The catalog is read with GET.", "method");
		}
		let key = presented(request);
		if (key === null) {
			return failure(401, "Send one key, as Authorization: Bearer or x-api-key.", "no-placeholder");
		}
		// The catalog is fetched with nothing of the request: a stand-in anywhere but the key is lost.
		let query = queried(url.search);
		if (query === "unreadable") {
			return failure(
				400,
				"This request's query has a name or value that can't be decoded. Send the catalog request without it.",
				"unreadable-query",
			);
		}
		if (query === "stand-in") {
			return failure(
				400,
				"This request carries a key Chopin gave a launch in its query, which the catalog doesn't use. Send the key only in Authorization or x-api-key.",
				"dropped-query",
			);
		}
		if (standInDropped(request, () => true)) return droppedStandIn();
		let launchToken = request.headers.get(AI_LAUNCH_HEADER)?.trim() || undefined;
		if (!catalog || clock() - catalog.fetchedAt >= CATALOG_FRESH_MS) {
			let admitted = await options.credentials.forLaunch(key, launchToken, () => true as const);
			if (admitted !== true) return refused(admitted.refused);
			let upstream: Response;
			try {
				upstream = await send(upstreamUrl(options.upstreams?.catalog ?? MODEL_CATALOG, path, ""), {
					headers: { accept: "application/json" },
					redirect: "manual",
					signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
				});
			} catch {
				if (!catalog) return failure(502, "The model catalog can't be reached.", "upstream");
				upstream = new Response(null, { status: 502 });
			}
			if (upstream.ok) {
				let headers = new Headers({ "content-type": "application/json" });
				for (let name of ["etag", "last-modified"]) {
					let value = upstream.headers.get(name);
					if (value) headers.set(name, value);
				}
				catalog = {
					body: new Uint8Array(await upstream.arrayBuffer()),
					headers,
					fetchedAt: clock(),
				};
			} else {
				await upstream.body?.cancel();
				if (!catalog) return failure(502, "The model catalog can't be reached.", "upstream");
			}
		}
		let held = catalog;
		let served = await options.credentials.forLaunch(key, launchToken, () => {
			let etag = held.headers.get("etag");
			let headers = new Headers(held.headers);
			headers.set("cache-control", "no-cache");
			if (etag && request.headers.get("if-none-match") === etag) {
				return new Response(null, { status: 304, headers });
			}
			return new Response(request.method === "HEAD" ? null : held.body.slice(), { headers });
		});
		return served instanceof Response ? served : refused(served.refused);
	};

	/**
	 * `GET /api/v1/ai/launch`: whether the launch whose own credential the request carries in
	 * `AI_LAUNCH_HEADER` is live, for its runner to tell an ended launch from a stand-in its agent
	 * got wrong when the proxy refuses one. It stays `ended` once the launch's placeholders are gone,
	 * however they went; a credential no launch has reads as ended, which tells its holder nothing it
	 * could use. A process that no longer holds the writer lease can't say, and answers 503.
	 */
	let serveLaunch = async (request: Request, path: string): Promise<Response> => {
		if (path !== "/") {
			return failure(404, "Only the launch's own state is served here.", "not-found");
		}
		if (request.method !== "GET") return failure(405, "The launch is read with GET.", "method");
		let launchToken = request.headers.get(AI_LAUNCH_HEADER)?.trim();
		if (!launchToken) return refused("no-launch");
		let state = await options.credentials.launchStatus(launchToken);
		if (state === "restarting") return refused("restarting");
		return Response.json({ state }, {
			headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
		});
	};

	return async (request: Request, url: URL): Promise<Response> => {
		let rest = url.pathname.slice(AI_PROXY_PATH.length + 1);
		let slash = rest.indexOf("/");
		let name = slash < 0 ? rest : rest.slice(0, slash);
		let path = slash < 0 ? "/" : rest.slice(slash);
		if (name === "models.dev") return serveCatalog(request, url, path);
		if (name === "launch") return serveLaunch(request, path);
		if (!isAiProvider(name)) {
			return failure(404, "Chopin doesn't proxy this provider.", "not-found");
		}
		let provider = name;
		if (!routed(provider, request.method, path)) {
			return failure(404, "Chopin's proxy serves this provider's model API only.", "route");
		}
		let key = presented(request);
		if (key === null) {
			return failure(401, "Send one key, as Authorization: Bearer or x-api-key.", "no-placeholder");
		}
		if (standInDropped(request, dropped)) return droppedStandIn();
		let launchToken = request.headers.get(AI_LAUNCH_HEADER)?.trim() || undefined;
		let checked = await options.credentials.authorize(key, provider, launchToken);
		if ("refused" in checked) return refused(checked.refused);
		let body = request.method === "GET" ? undefined : await boundedBody(request);
		if (body === undefined && request.method !== "GET") {
			return failure(413, "The request is too large.", "too-large");
		}
		let attempt: AiAttemptRecord | undefined;
		if (options.usage) {
			try {
				attempt = await options.usage.begin(checked.placeholder, body);
			} catch {
				return failure(
					503,
					"Chopin can't record this request now, so it wasn't sent. Send it again in a moment.",
					"unrecorded",
				);
			}
		}
		/** Whether the transport took the request, which a final check that throws can come after. */
		let taken = false;
		let handed = await options.credentials.handoff(checked, authorized => {
			let headers = forwardedHeaders(request);
			headers.set(
				CREDENTIAL_HEADER[provider],
				CREDENTIAL_HEADER[provider] === "authorization"
					? `Bearer ${authorized.secret}`
					: authorized.secret,
			);
			let origin = options.upstreams?.[provider] ?? authorized.origin ?? AI_UPSTREAMS[provider];
			let target = upstreamUrl(origin, path, url.search);
			let init: RequestInit = {
				method: request.method,
				headers,
				...(body ? { body } : {}),
				redirect: "manual",
				signal: request.signal,
			};
			// The transport checks the deadlines on the very clock reading it takes the request at.
			return (deadlines: AiDeadlines): AiAdmitted<Handed> => {
				let admitted = transport(target, init, deadlines);
				if ("late" in admitted) return admitted;
				taken = true;
				return {
					sent: { secret: authorized.secret, record: authorized.record, upstream: admitted.sent },
					at: admitted.at,
				};
			};
		}, request.signal).catch((err: unknown) => {
			// A final check that failed before the transport took the request sent nothing.
			if (!taken) attempt?.unsent("unchecked");
			throw err;
		});
		if ("refused" in handed) {
			attempt?.unsent(handed.refused);
			return refused(handed.refused);
		}
		let { secret } = handed;
		let upstream: Response;
		try {
			upstream = await handed.upstream;
		} catch {
			if (request.signal.aborted) {
				attempt?.failed("cancelled");
				return failedHolding(secret, 499, "The request was cancelled.", "cancelled");
			}
			attempt?.failed("unreachable");
			return failedHolding(secret, 502, `${provider} can't be reached.`, "upstream");
		}
		if (!readable(upstream)) {
			attempt?.failed("upstream-encoding", upstream.status);
			await upstream.body?.cancel();
			return failedHolding(
				secret,
				502,
				`${provider} answered in an encoding Chopin can't read to take the key out of.`,
				"upstream-encoding",
			);
		}
		let refusal = KEY_REFUSED[provider];
		if (upstream.status === 401 && refusal) {
			// Read whole, to learn whether it refused the key itself, and passed back as it came.
			let body: Uint8Array<ArrayBuffer>;
			try {
				body = new Uint8Array(await upstream.arrayBuffer());
			} catch {
				attempt?.failed("unreachable", upstream.status);
				return failedHolding(secret, 502, `${provider} can't be reached.`, "upstream");
			}
			if (body.byteLength <= MAX_REFUSAL && refusal(parsed(body))) {
				await options.credentials.rejected(handed.record).catch(err =>
					console.warn("[ai] couldn't record that a provider refused a key", err)
				);
			}
			upstream = new Response(body, { status: upstream.status, headers: upstream.headers });
		}
		let headers = returnedHeaders(upstream, secret);
		if (!headers) {
			attempt?.failed("upstream-headers", upstream.status);
			await upstream.body?.cancel();
			return failedHolding(
				secret,
				502,
				`${provider}'s answer can't be passed back: a header Chopin adds to it would carry the key.`,
				"upstream-headers",
			);
		}
		let passed = upstream.body && scrubbed(upstream.body, secret);
		return new Response(
			attempt ? attempt.answered(upstream.status, headers.get("content-type"), passed) : passed,
			{ status: upstream.status, headers },
		);
	};
}
