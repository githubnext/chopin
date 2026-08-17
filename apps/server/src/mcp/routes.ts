import { handler } from "../mcp";
import { hosted } from "./hosted";

import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";

function failure(): Response {
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
export function registerMcpRoutes(router: Router, auth: HostedAuth): void {
	let endpoint = handler(hosted(auth));
	let route = async (request: Request): Promise<Response> => {
		if (request.headers.has("origin") && request.headers.get("origin") !== auth.config.origin) {
			return protectedResponse(new Response("origin is not allowed", { status: 403 }));
		}
		try {
			return protectedResponse(await endpoint(request));
		} catch {
			return protectedResponse(failure());
		}
	};
	router.on("GET", "/mcp", route);
	router.on("POST", "/mcp", route);
}
