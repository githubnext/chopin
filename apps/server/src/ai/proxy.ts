import { AI_PROXY_PATH, isAiProvider } from "@chopin/protocol/ai-credentials";

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

/** The largest request body the proxy forwards: well past any model request with images. */
const MAX_BODY = 64 * 1024 * 1024;
const CATALOG_FRESH_MS = 10 * 60 * 1000;

/** Request headers never forwarded: a credential, the hop's own, and what names the caller. */
const DROPPED_REQUEST = new Set([
	"authorization",
	"x-api-key",
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
/** Response headers never passed back: what belongs to the upstream hop or sets its cookies. */
const DROPPED_RESPONSE = new Set([
	"set-cookie",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-encoding",
	"content-length",
	"alt-svc",
]);

const REFUSALS: Record<AiRefusal, { status: number; message: string }> = {
	"no-placeholder": {
		status: 401,
		message: "Send the key Chopin gave this launch in Authorization or x-api-key.",
	},
	"unknown-placeholder": { status: 401, message: "Chopin doesn't know this key." },
	"other-provider": { status: 401, message: "This key is for another provider." },
	"launch-ended": { status: 401, message: "The launch this key was given to has ended." },
	"not-connected": {
		status: 403,
		message: "This provider is no longer connected in Chopin. Connect it again in Chopin.",
	},
	"sign-in-unavailable": {
		status: 403,
		message: "Chopin can't read your GitHub sign-in now. Sign in to Chopin again.",
	},
	"no-copilot-access": {
		status: 403,
		message: "Your GitHub account has no Copilot subscription.",
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

function returnedHeaders(upstream: Response): Headers {
	let headers = new Headers();
	for (let [name, value] of upstream.headers) {
		if (!DROPPED_RESPONSE.has(name)) headers.append(name, value);
	}
	headers.set("cache-control", upstream.headers.get("cache-control") ?? "no-store");
	return headers;
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

type CachedCatalog = { body: Uint8Array; headers: Headers; fetchedAt: number };

/**
 * Chopin's AI credential proxy, served at `/api/v1/ai/<provider>/...`. A request must carry, in
 * `Authorization: Bearer` or `x-api-key`, a placeholder a live launch was handed for that
 * provider. The proxy drops both headers, puts the real credential of the launch's person in the
 * one header the provider takes it in, and sends the request, path, query and body unchanged, to
 * the provider's own origin and nowhere else: a placeholder anywhere else in the request is sent
 * on as it is, and a redirect comes back to the agent rather than being followed with the
 * credential. `/api/v1/ai/models.dev/api.json` serves the public model catalog, which needs no
 * credential, held for ten minutes.
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
		let key = presented(request);
		if (key === null) {
			return failure(401, "Send one key, as Authorization: Bearer or x-api-key.", "no-placeholder");
		}
		let authorized = await options.credentials.authorize(key, provider);
		if ("refused" in authorized) {
			let refusal = REFUSALS[authorized.refused];
			return failure(refusal.status, refusal.message, authorized.refused);
		}
		let body = request.method === "GET" || request.method === "HEAD"
			? undefined
			: await boundedBody(request);
		if (body === undefined && request.method !== "GET" && request.method !== "HEAD") {
			return failure(413, "The request is too large.", "too-large");
		}
		let headers = forwardedHeaders(request);
		headers.set(
			CREDENTIAL_HEADER[provider],
			CREDENTIAL_HEADER[provider] === "authorization"
				? `Bearer ${authorized.secret}`
				: authorized.secret,
		);
		let upstream: Response;
		try {
			upstream = await send(
				upstreamUrl(options.upstreams?.[provider] ?? AI_UPSTREAMS[provider], path, url.search),
				{
					method: request.method,
					headers,
					...(body ? { body } : {}),
					redirect: "manual",
					signal: request.signal,
				},
			);
		} catch {
			if (request.signal.aborted) return failure(499, "The request was cancelled.", "cancelled");
			return failure(502, `${provider} can't be reached.`, "upstream");
		}
		return new Response(request.method === "HEAD" ? null : upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: returnedHeaders(upstream),
		});
	};
}
