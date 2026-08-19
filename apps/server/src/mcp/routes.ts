import { handler } from "../mcp";
import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";
import { hosted } from "./hosted";

import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";
import type { ImplementationPersistence } from "./hosted";

function failure(err: unknown): Response {
	if (err instanceof AdmissionDenied) return new Response("forbidden", { status: 403 });
	if (err instanceof GitHubError) {
		if (err.status === 401) return new Response("unauthorized", { status: 401 });
		if (err.status === 429 || err.status >= 500) {
			return new Response("GitHub access is temporarily unavailable", { status: 503 });
		}
	}
	return new Response("MCP request failed", { status: 500 });
}

function protectedResponse(response: Response): Response {
	let headers = new Headers(response.headers);
	headers.set("cache-control", "no-store");
	headers.set("x-content-type-options", "nosniff");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Register the hosted, read-only MCP endpoint. */
export function registerMcpRoutes(
	router: Router,
	auth: HostedAuth,
	persistence?: ImplementationPersistence,
): void {
	let endpoint = handler(hosted(auth, persistence));
	let route = async (request: Request): Promise<Response> => {
		if (request.headers.has("origin") && request.headers.get("origin") !== auth.config.origin) {
			return protectedResponse(new Response("origin is not allowed", { status: 403 }));
		}
		try {
			return protectedResponse(await endpoint(request));
		} catch (err) {
			return protectedResponse(failure(err));
		}
	};
	router.on("GET", "/mcp", route);
	router.on("POST", "/mcp", route);
}
