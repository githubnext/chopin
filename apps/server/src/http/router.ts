export type RouteHandler = (request: Request, url: URL) => Response | Promise<Response>;

type Routes = Map<string, Map<string, RouteHandler>>;

function plain(status: number, message: string, headers?: HeadersInit): Response {
	return new Response(message, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
			...headers,
		},
	});
}

/** Exact application routes in front of the development or production SPA. */
export class Router {
	readonly #routes: Routes = new Map();

	on(method: string, path: string, handler: RouteHandler): void {
		let methods = this.#routes.get(path) ?? new Map<string, RouteHandler>();
		if (methods.has(method)) throw new Error(`${method} ${path} is already registered`);
		methods.set(method, handler);
		this.#routes.set(path, methods);
	}

	async handle(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
		let methods = this.#routes.get(url.pathname);
		if (methods) {
			let handler = methods.get(request.method);
			if (handler) return handler(request, url);
			return plain(405, "method not allowed", {
				allow: [...methods.keys()].sort().join(", "),
			});
		}

		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			return plain(404, "API route not found");
		}
		if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
			return plain(404, "authentication route not found");
		}
		return undefined;
	}
}
