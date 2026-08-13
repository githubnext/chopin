export type RouteHandler = (
	request: Request,
	url: URL,
	params: Readonly<Record<string, string>>,
) => Response | Promise<Response>;

type Routes = Map<string, Map<string, RouteHandler>>;
type Pattern = {
	path: string;
	segments: string[];
	methods: Map<string, RouteHandler>;
};

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
	readonly #patterns: Pattern[] = [];

	on(method: string, path: string, handler: RouteHandler): void {
		if (path.split("/").some(segment => segment.startsWith(":"))) {
			let segments = path.split("/");
			let pattern = this.#patterns.find(value => value.path === path);
			if (!pattern) {
				pattern = { path, segments, methods: new Map() };
				this.#patterns.push(pattern);
			}
			if (pattern.methods.has(method)) throw new Error(`${method} ${path} is already registered`);
			pattern.methods.set(method, handler);
			return;
		}
		let methods = this.#routes.get(path) ?? new Map<string, RouteHandler>();
		if (methods.has(method)) throw new Error(`${method} ${path} is already registered`);
		methods.set(method, handler);
		this.#routes.set(path, methods);
	}

	async handle(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
		let methods = this.#routes.get(url.pathname);
		if (methods) {
			let handler = methods.get(request.method);
			if (handler) return handler(request, url, {});
			return plain(405, "method not allowed", {
				allow: [...methods.keys()].sort().join(", "),
			});
		}
		let matched = this.#match(url.pathname);
		if (matched) {
			let handler = matched.pattern.methods.get(request.method);
			if (handler) return handler(request, url, matched.params);
			return plain(405, "method not allowed", {
				allow: [...matched.pattern.methods.keys()].sort().join(", "),
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

	#match(path: string): { pattern: Pattern; params: Record<string, string> } | undefined {
		let segments = path.split("/");
		for (let pattern of this.#patterns) {
			if (pattern.segments.length !== segments.length) continue;
			let params: Record<string, string> = {};
			let matches = true;
			for (let index = 0; index < segments.length; index++) {
				let expected = pattern.segments[index]!;
				let actual = segments[index]!;
				if (!expected.startsWith(":")) {
					if (expected !== actual) matches = false;
					continue;
				}
				try {
					let decoded = decodeURIComponent(actual);
					if (!decoded || decoded.includes("/")) matches = false;
					else params[expected.slice(1)] = decoded;
				} catch {
					matches = false;
				}
			}
			if (matches) return { pattern, params };
		}
		return undefined;
	}
}
