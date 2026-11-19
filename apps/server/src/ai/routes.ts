import { AI_PROXY_PATH, isAiProvider } from "@chopin/protocol/ai-credentials";

import { ownOrigin } from "../auth/config";
import { StorageError } from "../storage/errors";
import { AiCredentialError } from "./credentials";

import type { AiCredentialList, ConnectAiCredential } from "@chopin/protocol/ai-credentials";
import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";
import type { AiPlaceholder } from "../storage/model";
import type { AiCredentials } from "./credentials";

const BODY_LIMIT = 8 * 1024;

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function empty(status: number): Response {
	return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function failed(err: unknown): Response {
	if (err instanceof AiCredentialError) return json({ error: err.message }, err.status);
	if (err instanceof StorageError && err.failure === "unavailable") {
		return json({ error: "storage is unavailable" }, 503);
	}
	return json({ error: "request failed" }, 500);
}

async function connection(request: Request): Promise<ConnectAiCredential | undefined> {
	let declared = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(declared) && declared > BODY_LIMIT) return undefined;
	let source = await request.text();
	if (new TextEncoder().encode(source).length > BODY_LIMIT) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let body = value as Record<string, unknown>;
	if (body.kind === "github-sign-in") return { kind: "github-sign-in" };
	if (body.kind === "api-key" && typeof body.secret === "string") {
		return { kind: "api-key", secret: body.secret };
	}
	return undefined;
}

/**
 * The current GitHub token of the person a launch runs for, which Chopin renews: a paired
 * machine's own GitHub authorization when the launch runs on their own machine, else their live
 * browser sign-in.
 */
export function githubSignIn(auth: HostedAuth) {
	return async (
		launch: Pick<AiPlaceholder, "userId" | "machineId">,
	): Promise<string | undefined> => {
		if (launch.machineId && auth.machines.durable) {
			let machine = await auth.storage.machines.get(launch.machineId);
			if (machine && !machine.revokedAt && machine.userId === launch.userId) {
				let access = await auth.machines.access(machine).catch(() => undefined);
				if (access) return access.token;
			}
		}
		return (await auth.sessions.forUser(launch.userId))?.access.token;
	};
}

/**
 * The AI credentials a signed-in person connects, and Chopin's credential proxy. The list says
 * which providers are connected and how, never a secret; connecting and disconnecting take a
 * request from Chopin's own origin. The proxy (see `aiProxy`) takes a launch's placeholder, not a
 * sign-in.
 */
export function registerAiRoutes(
	router: Router,
	auth: HostedAuth,
	options: {
		credentials: AiCredentials;
		proxy: (request: Request, url: URL) => Promise<Response>;
	},
): void {
	let { credentials } = options;

	router.on("GET", "/api/ai/credentials", async request => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let listed = await credentials.list(session.user.id, session.access.token);
			return json({ credentials: listed } as AiCredentialList);
		} catch (err) {
			return failed(err);
		}
	});

	router.on("PUT", "/api/ai/credentials/:provider", async (request, _url, params) => {
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let provider = params.provider;
			if (!isAiProvider(provider)) return json({ error: "unknown provider" }, 404);
			let input = await connection(request);
			if (!input) return json({ error: "invalid request" }, 400);
			return json(
				await credentials.connect(session.user.id, provider, input, session.access.token),
			);
		} catch (err) {
			return failed(err);
		}
	});

	router.on("POST", "/api/ai/credentials/github-copilot/check", async request => {
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			return json(await credentials.check(session.user.id, session.access.token));
		} catch (err) {
			return failed(err);
		}
	});

	router.on("DELETE", "/api/ai/credentials/:provider", async (request, _url, params) => {
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let provider = params.provider;
			if (!isAiProvider(provider)) return json({ error: "unknown provider" }, 404);
			return empty(await credentials.disconnect(session.user.id, provider) ? 204 : 404);
		} catch (err) {
			return failed(err);
		}
	});

	router.prefix(`${AI_PROXY_PATH}/`, (request, url) => options.proxy(request, url));
}
