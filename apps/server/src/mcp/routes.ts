import { handler } from "../mcp";
import { hosted } from "./hosted";

import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";

function failure(): Response {
	return new Response("MCP request failed", { status: 500 });
}

/** Register the hosted, read-only MCP endpoint. */
export function registerMcpRoutes(router: Router, auth: HostedAuth): void {
	let endpoint = handler(hosted(auth));
	let route = async (request: Request): Promise<Response> => {
		if (request.headers.has("origin") && request.headers.get("origin") !== auth.config.origin) {
			return new Response("origin is not allowed", { status: 403 });
		}
		try {
			return await endpoint(request);
		} catch {
			return failure();
		}
	};
	router.on("GET", "/mcp", route);
	router.on("POST", "/mcp", route);
}
