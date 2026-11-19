import { AI_LAUNCH_HEADER, AI_PROXY_PATH, isAiProvider } from "@chopin/protocol/ai-credentials";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { AiCredentials, AiRefusal } from "./credentials";

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
};

export type AiProxyOptions = {
	credentials: AiCredentials;
	/** Each provider's origin, and the catalog's; tests point them at fakes. */
	upstreams?: Partial<Record<AiProvider, string>> & { catalog?: string };
	fetch?: typeof fetch;
	clock?: () => number;
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

function forwardedHeaders(request: Request): Headers {
	let headers = new Headers();
	for (let [name, value] of request.headers) {
		if (DROPPED_REQUEST.has(name) || name.startsWith("x-forwarded-")) continue;
		headers.append(name, value);
	}
	return headers;
}

function routed(provider: AiProvider, method: string, path: string): boolean {
	return ROUTES[provider].some(route => route.methods.includes(method) && route.path.test(path));
}

/**
 * The upstream's headers to pass back: only those `RETURNED_RESPONSE` names, each with `secret`
 * replaced wherever its value holds it, and `no-store` when the provider says nothing of caching.
 * The allow-list and the replacement are the last step, so no value is set after them.
 */
function returnedHeaders(upstream: Response, secret: string): Headers {
	let headers = new Headers({ "cache-control": "no-store" });
	for (let [name, value] of upstream.headers) {
		if (
			RETURNED_RESPONSE.has(name)
			|| RETURNED_RESPONSE_PREFIXES.some(prefix => name.startsWith(prefix))
		) {
			headers.set(name, value.replaceAll(secret, REDACTED_TEXT));
		}
	}
	return headers;
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
 * chunk that could begin the secret waits for the next chunk, so a stream is not held back.
 */
function scrubbed(body: ReadableStream<Uint8Array>, secret: string): ReadableStream<Uint8Array> {
	let needle = new TextEncoder().encode(secret);
	let pending: Uint8Array = new Uint8Array();
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
				let held = partialMatch(rest, needle);
				parts.push(rest.subarray(0, rest.length - held));
				pending = rest.slice(rest.length - held);
				let out = parts.reduce(joined, new Uint8Array());
				if (out.length) controller.enqueue(out);
			},
			flush(controller) {
				if (pending.length) controller.enqueue(pending);
			},
		}),
	);
}

type CachedCatalog = { body: Uint8Array; headers: Headers; fetchedAt: number };

/**
 * Chopin's AI credential proxy, served at `/api/v1/ai/<provider>/...`, for the provider's model
 * API routes alone (`ROUTES`). A request must carry, in `Authorization: Bearer` or `x-api-key`, a
 * placeholder a live launch was handed for that provider, and in `AI_LAUNCH_HEADER` the credential
 * of that same launch, which its runner adds. The proxy drops these headers, reads the body, checks
 * the launch is still live (and takes a fresh Copilot token for one that expired meanwhile), puts
 * the real credential of the launch's person in the one header the provider takes it in, and sends
 * the request, path, query and body unchanged, to the provider's own origin and nowhere else: a
 * placeholder anywhere else in the request is sent on as it is, and a redirect comes back to the
 * agent rather than being followed with the credential. The answer carries the provider's status
 * code, never its reason phrase, and a credential the provider echoes is taken out of the headers
 * and body it answers with. `/api/v1/ai/models.dev/api.json` serves the public model catalog,
 * which needs no credential, held for ten minutes.
 */
export function aiProxy(options: AiProxyOptions) {
	let send = options.fetch ?? fetch;
	let clock = options.clock ?? Date.now;
	let catalog: CachedCatalog | undefined;

	let serveCatalog = async (request: Request, path: string): Promise<Response> => {
		if (path !== "/api.json") return failure(404, "Only the catalog is served here.", "not-found");
		if (request.method !== "GET" && request.method !== "HEAD") {
			return failure(405, "The catalog is read with GET.", "method");
		}
		if (!catalog || clock() - catalog.fetchedAt >= CATALOG_FRESH_MS) {
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
		let etag = catalog.headers.get("etag");
		let headers = new Headers(catalog.headers);
		headers.set("cache-control", "no-cache");
		if (etag && request.headers.get("if-none-match") === etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(request.method === "HEAD" ? null : catalog.body.slice(), { headers });
	};

	return async (request: Request, url: URL): Promise<Response> => {
		let rest = url.pathname.slice(AI_PROXY_PATH.length + 1);
		let slash = rest.indexOf("/");
		let name = slash < 0 ? rest : rest.slice(0, slash);
		let path = slash < 0 ? "/" : rest.slice(slash);
		if (name === "models.dev") return serveCatalog(request, path);
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
		let launchToken = request.headers.get(AI_LAUNCH_HEADER)?.trim() || undefined;
		let checked = await options.credentials.authorize(key, provider, launchToken);
		if ("refused" in checked) return refused(checked.refused);
		let body = request.method === "GET" ? undefined : await boundedBody(request);
		if (body === undefined && request.method !== "GET") {
			return failure(413, "The request is too large.", "too-large");
		}
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
			let upstream = (async () =>
				send(target, {
					method: request.method,
					headers,
					...(body ? { body } : {}),
					redirect: "manual",
					signal: request.signal,
				}))();
			return { secret: authorized.secret, upstream };
		});
		if ("refused" in handed) return refused(handed.refused);
		let upstream: Response;
		try {
			upstream = await handed.upstream;
		} catch {
			if (request.signal.aborted) return failure(499, "The request was cancelled.", "cancelled");
			return failure(502, `${provider} can't be reached.`, "upstream");
		}
		if (!readable(upstream)) {
			await upstream.body?.cancel();
			return failure(
				502,
				`${provider} answered in an encoding Chopin can't read to take the key out of.`,
				"upstream-encoding",
			);
		}
		return new Response(upstream.body && scrubbed(upstream.body, handed.secret), {
			status: upstream.status,
			headers: returnedHeaders(upstream, handed.secret),
		});
	};
}
