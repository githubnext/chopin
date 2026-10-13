import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

export class ConnectorError extends Error {
	constructor(readonly code: string, message: string, readonly status?: number) {
		super(message);
	}
}

/** Sent on pairing and every connector request, so the server can refuse an incompatible CLI. */
export const CONNECTOR_HEADERS = {
	[CONNECTOR_VERSION_HEADER]: VERSION,
	[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
};

/** The server's refusal of this connector's version, which no retry can fix. */
export async function refusal(response: Response) {
	if (response.status !== 409) return;
	let body = await response.clone().json().catch(() => undefined) as
		| { error?: unknown; message?: unknown }
		| undefined;
	if (body?.error === CONNECTOR_UPDATE_REQUIRED && typeof body.message === "string") {
		return new ConnectorError(CONNECTOR_UPDATE_REQUIRED, body.message);
	}
}

/** Connect to Chopin; `signal` abandons the handshake, as Ctrl-C does. */
export async function remote(origin: string, token: string, signal?: AbortSignal) {
	let client = new Client({ name: "chopin-connector", version: VERSION });
	// The client keeps listening to the signal it was given, so it gets one that ends here.
	let handshake = new AbortController();
	let give = () => handshake.abort(signal!.reason);
	signal?.addEventListener("abort", give, { once: true });
	if (signal?.aborted) give();
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL("/connector/mcp", origin), {
				requestInit: { headers: { Authorization: `Bearer ${token}`, ...CONNECTOR_HEADERS } },
				// The SDK would quote the refusal's JSON inside its own HTTP error message.
				fetch: async (url, init) => {
					let response = await fetch(url, init);
					let refused = await refusal(response);
					if (refused) throw refused;
					return response;
				},
			}),
			{ signal: handshake.signal },
		);
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", give);
	}
	return {
		close: () => client.close(),
		tools: () => client.listTools(),
		invoke: (name: string, args: Record<string, unknown> = {}) =>
			client.callTool({ name, arguments: args }),
		async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
			let response = await client.callTool({ name, arguments: args }, undefined, {
				timeout: 45_000,
				signal,
			});
			if (response.isError) {
				let message = (response.content as Array<{ type: string; text?: string }>).find(item =>
					item.type === "text"
				)?.text ?? "Connector tool failed";
				throw new ConnectorError(
					message.match(/^([a-z][a-z0-9-]+):/)?.[1] ?? "unavailable",
					message,
				);
			}
			let content = response.content as Array<{ type: string; text?: string }>;
			let text = content.find(item => item.type === "text")?.text;
			if (!text) throw new Error("Missing connector response.");
			return JSON.parse(text) as unknown;
		},
	};
}
