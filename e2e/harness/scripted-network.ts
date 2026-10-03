export type ScriptedFetch = {
	(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response>;
	preconnect?: typeof fetch.preconnect;
};

/** Fixture-only fetch boundary, installed before the GitHub, Jev and exact MCP fakes. */
export function createScriptedFetch(network: ScriptedFetch): typeof fetch {
	function allow(input: Parameters<typeof fetch>[0]): URL {
		let url: URL;
		try {
			if (!(typeof input === "string" || input instanceof URL || input instanceof Request)) {
				throw new Error();
			}
			url = new URL(input instanceof Request ? input.url : input);
		} catch {
			throw new Error("Scripted Planner network request refused");
		}
		if (
			url.username || url.password || url.protocol !== "http:"
			|| !["http://127.0.0.1:8788", "http://127.0.0.1:8797"].includes(url.origin)
		) {
			throw new Error("Scripted Planner network request refused");
		}
		return url;
	}

	let guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		allow(input);
		let request: Request;
		try {
			// Native normalization retains inherited options and snapshots a mutable URL.
			let original = new Request(input, init);
			// Fixture HTTP never follows redirects, even to another local origin.
			request = new Request(original, { redirect: "error" });
		} catch {
			throw new Error("Scripted Planner network request refused");
		}
		allow(request);
		return network(request);
	};
	let preconnect = network.preconnect;
	return Object.assign(guarded, {
		preconnect(input: string | URL, options?: Parameters<typeof fetch.preconnect>[1]) {
			let captured: Parameters<typeof fetch.preconnect>[1];
			try {
				captured = options === undefined ? undefined : {
					dns: options.dns,
					tcp: options.tcp,
					http: options.http,
					https: options.https,
				};
			} catch {
				throw new Error("Scripted Planner network request refused");
			}
			let url = allow(input);
			preconnect?.call(network, url.href, captured);
		},
	});
}
