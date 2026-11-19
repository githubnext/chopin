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
	 * Relays one launch under a random path of its own. `ended` hears that Chopin said the launch
	 * has ended (revoked machine, archived document, removed credential or deadline), once.
	 */
	open(launch: string, providers: AiProviderGrant[], ended?: () => void): RelayedLaunch;
	close(): Promise<void>;
};

type Held = { launch: string; providers: AiProviderGrant[]; ended?: () => void; told: boolean };

function refusal(status: number, code: string) {
	return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

/** Whether Chopin's answer says the launch is over. */
async function launchEnded(response: Response) {
	if (response.status !== 401) return false;
	try {
		let answer = await response.clone().json() as { code?: unknown };
		return answer.code === "launch-ended";
	} catch {
		return false;
	}
}

/** Starts the relay on loopback. */
export function startAiRelay(options: { fetch?: typeof fetch } = {}): AiRelay {
	let send = options.fetch ?? fetch;
	let launches = new Map<string, Held>();
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
			if (!held.told && await launchEnded(answer)) {
				held.told = true;
				held.ended?.();
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
