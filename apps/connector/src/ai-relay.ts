import { randomBytes } from "node:crypto";
import {
	AI_LAUNCH_HEADER,
	AI_PROXY_PATH,
	type AiProvider,
	type AiProviderGrant,
} from "@chopin/protocol/ai-credentials";

/**
 * The headers a hop sets for itself, which the relay neither forwards nor passes back. A body the
 * relay's own fetch decoded is passed back decoded, so its coding and length go too.
 */
const HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);
const DECODED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

/** One launch's relayed base URLs, the agent's in place of Chopin's. */
export type RelayedLaunch = {
	/** Each granted provider's base URL on the relay, standing for its `baseUrl` on Chopin. */
	baseUrls: Partial<Record<AiProvider, string>>;
	/** The models.dev catalog's base URL on the relay, which answers a live launch alone. */
	catalogUrl: string;
	/** Stops relaying for the launch. */
	close(): void;
};

/**
 * A loopback relay between a run's agent and Chopin's credential proxy. The agent sends each
 * provider's requests to the relay with the stand-in it was given; the relay adds the launch's own
 * credential (`x-chopin-launch`), which stays in the connector's memory, and forwards them to that
 * provider's base URL on Chopin and nowhere else. So the agent, its tools and its files never hold
 * the launch's credential, and a stand-in copied out of the agent's sandbox reaches nothing.
 */
export type AiRelay = {
	/** The relay's `host:port`, which a sandbox's proxy allows. */
	host: string;
	/**
	 * Relays one launch under a random path of its own. `ended` hears, once, that the launch has
	 * ended (an end, a revoked machine, an archived document, its deadline, its run ending), which
	 * the relay learns when Chopin's proxy refuses the agent a request as one for an ended or unknown
	 * stand-in and Chopin, asked with the launch's own credential, says the launch is no longer live
	 * (`GET /api/v1/ai/launch`). A provider's own refusal, and a stand-in the agent got wrong on a
	 * live launch, end nothing. Once ended, the relay refuses the launch's requests itself.
	 */
	open(launch: string, providers: AiProviderGrant[], ended?: () => void): RelayedLaunch;
	close(): Promise<void>;
};

type Held = {
	launch: string;
	providers: AiProviderGrant[];
	ended?: () => void;
	told: boolean;
	/** Chopin being asked whether the launch is live, once for every refusal meanwhile. */
	asking?: Promise<boolean> | undefined;
};

function refusal(status: number, code: string) {
	return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

/** What the relay answers for a launch it knows ended, in the shape Chopin's proxy refuses in. */
function ended() {
	return Response.json(
		{
			error: {
				message: "The launch this key was given to has ended.",
				type: "chopin_proxy",
				code: "launch-ended",
			},
		},
		{ status: 401, headers: { "cache-control": "no-store" } },
	);
}

/**
 * The code of a refusal Chopin's proxy answered, in the shape it answers in (`{ error: { type:
 * "chopin_proxy", code } }`), when it is one that may mean the launch ended: `launch-ended` or
 * `unknown-placeholder`. A provider's own answer, a 401 among them, is none.
 */
async function endRefusal(response: Response) {
	if (response.status !== 401) return undefined;
	try {
		let answer = await response.clone().json() as { error?: { type?: unknown; code?: unknown } };
		let code = answer?.error?.type === "chopin_proxy" ? answer.error.code : undefined;
		return code === "launch-ended" || code === "unknown-placeholder" ? code : undefined;
	} catch {
		return undefined;
	}
}

/** Starts the relay on loopback. */
export function startAiRelay(options: { fetch?: typeof fetch } = {}): AiRelay {
	let send = options.fetch ?? fetch;
	let launches = new Map<string, Held>();
	/**
	 * Whether Chopin says `held`'s launch is over, asked with its own credential after its proxy
	 * refused a request with `code`. A Chopin from before it answered this says nothing (404), and
	 * then only its `launch-ended` is taken at its word; one that can't be asked ends nothing.
	 */
	let over = async (held: Held, code: string): Promise<boolean> => {
		let first = held.providers[0];
		if (!first) return false;
		try {
			let answer = await send(`${new URL(first.baseUrl).origin}${AI_PROXY_PATH}/launch`, {
				headers: { [AI_LAUNCH_HEADER]: held.launch },
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			});
			if (answer.status === 404) {
				await answer.body?.cancel();
				return code === "launch-ended";
			}
			if (!answer.ok) {
				await answer.body?.cancel();
				return false;
			}
			let { state } = await answer.json() as { state?: unknown };
			return state === "ended";
		} catch {
			return false;
		}
	};
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// A model's answer can pause for minutes while it reasons.
		idleTimeout: 0,
		async fetch(request) {
			let url = new URL(request.url);
			let [, key = "", provider = ""] = url.pathname.split("/");
			let held = launches.get(key);
			if (!held) return refusal(404, "no-launch");
			if (held.told) return ended();
			let rest = url.pathname.slice(`/${key}/${provider}`.length);
			if (rest && !rest.startsWith("/")) return refusal(404, "route");
			let headers = new Headers();
			for (let [name, value] of request.headers) {
				if (!HOP.has(name) && name !== AI_LAUNCH_HEADER) headers.set(name, value);
			}
			headers.set(AI_LAUNCH_HEADER, held.launch);
			headers.set("accept-encoding", "identity");
			let target: string;
			if (provider === "models.dev") {
				let first = held.providers[0];
				if (!first) return refusal(404, "no-launch");
				target = `${new URL(first.baseUrl).origin}${AI_PROXY_PATH}/models.dev${rest}`;
				headers.set("authorization", `Bearer ${first.placeholder}`);
			} else {
				let grant = held.providers.find(value => value.provider === provider);
				if (!grant) return refusal(404, "other-provider");
				target = `${grant.baseUrl}${rest}`;
			}
			let answer: Response;
			try {
				answer = await send(`${target}${url.search}`, {
					method: request.method,
					headers,
					...(request.method === "GET" || request.method === "HEAD"
						? {}
						: { body: request.body, duplex: "half" as const }),
					redirect: "manual",
					signal: request.signal,
				});
			} catch {
				return refusal(502, "chopin-unreachable");
			}
			let code = held.told ? undefined : await endRefusal(answer);
			if (code && await (held.asking ??= over(held, code).finally(() => held.asking = undefined))) {
				if (!held.told) {
					held.told = true;
					held.ended?.();
				}
			}
			let returned = new Headers();
			for (let [name, value] of answer.headers) {
				if (!DECODED.has(name)) returned.append(name, value);
			}
			return new Response(answer.body, { status: answer.status, headers: returned });
		},
	});
	let host = `127.0.0.1:${server.port}`;
	return {
		host,
		open(launch, providers, ended) {
			let key = randomBytes(32).toString("base64url");
			launches.set(key, { launch, providers, ...(ended ? { ended } : {}), told: false });
			let base = `http://${host}/${key}`;
			return {
				baseUrls: Object.fromEntries(
					providers.map(grant => [grant.provider, `${base}/${grant.provider}`]),
				),
				catalogUrl: `${base}/models.dev`,
				close: () => void launches.delete(key),
			};
		},
		close: async () => {
			launches.clear();
			await server.stop(true);
		},
	};
}
