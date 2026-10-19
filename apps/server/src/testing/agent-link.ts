import { createConnection, createServer } from "node:net";

import { AGENT_PATH, AGENT_SUBPROTOCOL } from "@chopin/agent-link";
import { agentUrl, connectAgent } from "@chopin/agent-link/client";

import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";
import { Sessions } from "../auth/session";
import { PlannerAttachments } from "../harness/remote/attachments";
import { admitAgent, AGENT_UPGRADE_HEADERS, openAgentSocket } from "../harness/remote/endpoint";
import { MemoryStorage } from "../storage/memory/adapter";

import type { AgentClient, AgentHandlers, TurnContext } from "@chopin/agent-link/client";
import type { AddressInfo, Socket } from "node:net";
import type { ServerWebSocket } from "bun";
import type { Repository } from "../github/client";
import type { AttachmentAuth } from "../harness/remote/attachments";
import type { AgentAuth, AgentSocketData } from "../harness/remote/endpoint";
import type { AgentLink } from "../harness/remote/link";
import type { MachinePlanners } from "../harness/remote/machine-planners";

export const MEMBER_TOKEN = "member-token";
export const RIVAL_TOKEN = "rival-token";
export const VIEWER_TOKEN = "viewer-token";
export const GUEST_TOKEN = "guest-token";
export const OUTSIDER_TOKEN = "outsider-token";
export const DENIED_TOKEN = "denied-token";

const ACCOUNTS: Record<string, { id: string; login: string; push: boolean; signedIn: boolean }> = {
	[MEMBER_TOKEN]: { id: "U_member", login: "member", push: true, signedIn: true },
	[RIVAL_TOKEN]: { id: "U_rival", login: "rival", push: true, signedIn: true },
	[VIEWER_TOKEN]: { id: "U_viewer", login: "viewer", push: false, signedIn: true },
	[GUEST_TOKEN]: { id: "U_guest", login: "guest", push: true, signedIn: false },
};

function loginToken(login: string): string {
	return `${login}-browser-login`;
}

/** A paired machine's own GitHub token for `login`, as `machineToken("member", 1)`. */
export function machineToken(login: string, revision = 1): string {
	return `${login}-machine-${revision}`;
}

function machineAccount(token: string) {
	return Object.values(ACCOUNTS).find(value => token.startsWith(`${value.login}-machine-`));
}

/** octo-org/score, or another repository of the same accounts' by its own node ID. */
function scoreRepository(owner: string, name: string, push: boolean): Repository {
	return {
		id: name === "score" ? "R_score" : `R_${name}`,
		owner,
		name,
		fullName: `${owner}/${name}`,
		private: true,
		url: `https://github.test/${owner}/${name}`,
		defaultBranch: "main",
		permissions: { pull: true, push, admin: false },
	};
}

/**
 * GitHub as hosted MCP sees it: the member and the rival can push to
 * `octo-org/score` and are signed in to Chopin in a browser, the viewer can
 * only pull, the guest can push but never signed in, the outsider is a valid
 * account without access, the denied account fails admission, and every other
 * token is rejected by GitHub.
 */
export async function linkAuth(channelId?: string) {
	let storage = new MemoryStorage();
	let now = new Date();
	for (let account of Object.values(ACCOUNTS)) {
		await storage.users.put({ id: account.id, login: account.login, avatarUrl: "", now });
	}
	let clock = { skewMs: 0 };
	let revocations = new Set<(sessionId: string) => Promise<void>>();
	let sessions = new Sessions(storage, false, () => new Date(Date.now() + clock.skewMs), {
		onRevoked: async id => {
			for (let revoked of revocations) await revoked(id);
		},
	});
	let logins = new Map<string, string>();
	let cookies = new Map<string, string>();
	for (let account of Object.values(ACCOUNTS)) {
		if (!account.signedIn) continue;
		let issued = await sessions.issue(account.id, {
			accessToken: loginToken(account.login),
			accessExpiresIn: 28_800,
			refreshToken: "refresh-token",
			refreshExpiresIn: 86_400,
		});
		logins.set(account.login, issued.id);
		cookies.set(account.login, issued.cookie.split(";")[0]!);
	}
	let channel = await storage.channels.create({
		id: channelId ?? crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Linked document",
		createdBy: "U_member",
		now,
	});
	let auth = {
		config: { origin: "https://chopin.test" },
		storage,
		sessions,
		clock: () => new Date(),
		admission: {
			async user(token: string) {
				if (token === DENIED_TOKEN) throw new AdmissionDenied();
				let account = ACCOUNTS[token] ?? machineAccount(token);
				if (account) return { id: account.id, login: account.login, avatarUrl: "" };
				if (token === OUTSIDER_TOKEN) return { id: "U_outsider", login: "outsider", avatarUrl: "" };
				throw new GitHubError("Bad credentials", 401);
			},
			async allowed(token: string) {
				return token !== DENIED_TOKEN;
			},
		},
		github: {
			async repository(token: string, owner: string, name: string): Promise<Repository> {
				let account = ACCOUNTS[token] ?? machineAccount(token);
				if (!account) throw new GitHubError("Not Found", 404);
				return scoreRepository(owner, name, account.push);
			},
			/** The App is installed on octo-org/score and may write contents and pull requests. */
			async installedRepository(token: string, owner: string, name: string) {
				let account = machineAccount(token);
				return account
					? {
						repository: scoreRepository(owner, name, account.push),
						installation: { id: "1", writable: { contents: true, pullRequests: true } },
					}
					: undefined;
			},
			async repositoryAccess(token: string, owner: string, name: string) {
				let account = Object.values(ACCOUNTS).find(value => loginToken(value.login) === token)
					?? machineAccount(token);
				return account ? scoreRepository(owner, name, account.push) : undefined;
			},
		},
	};
	return {
		auth: auth as unknown as AgentAuth & AttachmentAuth & { github: typeof auth.github },
		storage,
		sessions,
		logins,
		/** Each signed-in account's browser cookie, by login. */
		cookies,
		channel,
		/** Moves the browser logins' clock, so they expire without the server's clock moving. */
		clock,
		/** Called with every browser login that ends, as `main.ts` wires `onSessionRevoked`. */
		revocations,
		/** Signs `login` out of the browser, as the logout route does. */
		async signOut(login: string) {
			let cookie = cookies.get(login)!;
			return sessions.revoke(new Request("https://chopin.test/", { headers: { cookie } }));
		},
	};
}

/**
 * A Bun server that serves only the agent connection, as the Chopin server does under HARNESS=remote.
 * `liveness` shortens how often the server pings the link and how long it waits to hear back.
 */
export function linkServer(
	auth: AgentAuth & AttachmentAuth,
	timeoutMs = 2_000,
	revalidateEveryMs?: number,
	graceMs = 2_000,
	liveness?: { pingEveryMs: number; pongTimeoutMs: number; maxSilenceMs?: number },
	planners?: MachinePlanners,
) {
	let links: AgentLink[] = [];
	let sockets = new Set<ServerWebSocket<AgentSocketData>>();
	let attachments = new PlannerAttachments(auth, graceMs);
	let server = Bun.serve<AgentSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, self) {
			if (new URL(request.url).pathname !== AGENT_PATH) {
				return new Response("not found", { status: 404 });
			}
			let outcome = await admitAgent(request, auth, true, planners);
			if (outcome instanceof Response) return outcome;
			return self.upgrade(request, { data: outcome, headers: AGENT_UPGRADE_HEADERS })
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
				openAgentSocket(ws, auth, {
					attachments,
					timeoutMs,
					revalidateEveryMs,
					...liveness,
					register(_channelId, link) {
						links.push(link);
						return () => {
							links = links.filter(candidate => candidate !== link);
						};
					},
				});
			},
			message(ws, raw) {
				ws.data.alive?.heard();
				ws.data.link?.receive(raw);
			},
			pong(ws) {
				ws.data.alive?.heard();
			},
			close(ws) {
				sockets.delete(ws);
				ws.data.alive?.stop();
				ws.data.link?.disconnected();
			},
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		attachments,
		get links() {
			return links;
		},
		/** The open link sockets as the server holds them, to write past the link itself. */
		get sockets() {
			return [...sockets];
		},
		stop: () => {
			attachments.close();
			return server.stop(true);
		},
	};
}

/**
 * A bare upgrade request to the agent connection, offering its subprotocol, so a test reads the
 * HTTP answer itself. A header given as "" is left out.
 */
export function upgradeRequest(
	url: string,
	headers: Record<string, string> = {},
	path = AGENT_PATH,
): Promise<Response> {
	let sent = {
		connection: "Upgrade",
		upgrade: "websocket",
		"sec-websocket-version": "13",
		"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
		"sec-websocket-protocol": AGENT_SUBPROTOCOL,
		...headers,
	};
	return fetch(`${url}${path}`, {
		headers: Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== "")),
	});
}

/** Raw frames over a socket that authenticated as the member, for protocol violations. */
/**
 * A link driven frame by frame. `features` is the `Chopin-Agent-Features` header it sends; by
 * default none, as a client written before that header existed.
 */
export async function rawLink(url: string, token = MEMBER_TOKEN, features?: string) {
	let socket = new (WebSocket as unknown as new(
		url: URL,
		init: { headers: Record<string, string>; protocols: string[] },
	) => WebSocket)(agentUrl(url), {
		headers: {
			authorization: `Bearer ${token}`,
			...(features === undefined ? {} : { "chopin-agent-features": features }),
		},
		protocols: [AGENT_SUBPROTOCOL],
	});
	let messages: any[] = [];
	let arrivals = new Set<() => void>();
	let closed = Promise.withResolvers<{ code: number; reason: string }>();
	socket.addEventListener("message", event => {
		messages.push(JSON.parse(String(event.data)));
		for (let wake of arrivals) wake();
	});
	socket.addEventListener("close", event => {
		closed.resolve({ code: event.code, reason: event.reason });
		for (let wake of arrivals) wake();
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("raw link failed")), { once: true });
	});
	async function next(type: string): Promise<any> {
		for (let deadline = Date.now() + 4_000; Date.now() < deadline;) {
			let found = messages.find(message => message.type === type);
			if (found) {
				messages.splice(messages.indexOf(found), 1);
				return found;
			}
			if (socket.readyState === WebSocket.CLOSED) break;
			await new Promise<void>(resolve => {
				let wake = () => {
					arrivals.delete(wake);
					resolve();
				};
				arrivals.add(wake);
				setTimeout(wake, 50);
			});
		}
		throw new Error(`no ${type} message arrived`);
	}
	return {
		socket,
		messages,
		next,
		send: (message: unknown) =>
			socket.send(typeof message === "string" ? message : JSON.stringify(message)),
		closed: closed.promise,
	};
}

/**
 * A member's link over a bare TCP socket that sends frames but never answers the
 * server's protocol pings, as a client whose network silently went away. Its
 * `closed` is the server's close frame, or 1006 when the socket ends without one.
 */
export async function silentLink(url: string, token = MEMBER_TOKEN) {
	let target = agentUrl(url);
	let messages: any[] = [];
	let pings = 0;
	let pending = Buffer.alloc(0);
	let upgraded = Promise.withResolvers<void>();
	let closed = Promise.withResolvers<{ code: number; reason: string }>();
	let handshaken = false;
	function frames() {
		while (pending.length >= 2) {
			let opcode = pending[0]! & 0x0f;
			let length = pending[1]! & 0x7f;
			let offset = 2;
			if (length === 126) [length, offset] = [pending.readUInt16BE(2), 4];
			else if (length === 127) [length, offset] = [Number(pending.readBigUInt64BE(2)), 10];
			if (pending.length < offset + length) return;
			let payload = pending.subarray(offset, offset + length);
			pending = pending.subarray(offset + length);
			if (opcode === 0x1) messages.push(JSON.parse(payload.toString("utf8")));
			if (opcode === 0x9) pings++;
			if (opcode === 0x8) {
				closed.resolve({
					code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
					reason: payload.subarray(2).toString("utf8"),
				});
			}
		}
	}
	let socket = await Bun.connect({
		hostname: target.hostname,
		port: Number(target.port),
		socket: {
			data(_socket, chunk) {
				pending = Buffer.concat([pending, chunk]);
				if (!handshaken) {
					let end = pending.indexOf("\r\n\r\n");
					if (end < 0) return;
					let status = pending.subarray(0, end).toString("latin1").split("\r\n")[0]!;
					if (!status.includes(" 101 ")) upgraded.reject(new Error(status));
					pending = pending.subarray(end + 4);
					handshaken = true;
					upgraded.resolve();
				}
				frames();
			},
			close() {
				upgraded.reject(new Error("silent link closed before upgrading"));
				closed.resolve({ code: 1006, reason: "" });
			},
		},
	});
	socket.write([
		`GET ${target.pathname} HTTP/1.1`,
		`Host: ${target.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version: 13",
		`Sec-WebSocket-Protocol: ${AGENT_SUBPROTOCOL}`,
		`Authorization: Bearer ${token}`,
		"",
		"",
	].join("\r\n"));
	await upgraded.promise;
	async function next(type: string): Promise<any> {
		for (let deadline = Date.now() + 4_000; Date.now() < deadline; await Bun.sleep(10)) {
			let found = messages.findIndex(message => message.type === type);
			if (found >= 0) return messages.splice(found, 1)[0];
		}
		throw new Error(`no ${type} message arrived`);
	}
	return {
		next,
		/** How many protocol pings the server has sent, none of them answered. */
		get pings() {
			return pings;
		},
		/** Sends one masked text frame, as a client must. */
		send(message: unknown) {
			let payload = Buffer.from(JSON.stringify(message));
			let header = payload.length < 126
				? Buffer.from([0x81, 0x80 | payload.length])
				: Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
			let mask = crypto.getRandomValues(Buffer.alloc(4));
			let masked = payload.map((byte, index) => byte ^ mask[index % 4]!);
			socket.write(Buffer.concat([header, mask, masked]));
		},
		closed: closed.promise,
		end: () => socket.end(),
	};
}

/**
 * A TCP proxy to `url` that forwards what a client uploads at only `bytes` every
 * `everyMs`, and what the server sends at full speed, as a client on a slow uplink.
 * `uploaded` counts the client bytes the server has been given.
 */
export async function slowUplink(url: string, bytes: number, everyMs: number) {
	let target = new URL(url);
	let sockets: Socket[] = [];
	let timers: ReturnType<typeof setInterval>[] = [];
	let uploaded = 0;
	let proxy = createServer(client => {
		let upstream = createConnection(Number(target.port), target.hostname);
		sockets.push(client, upstream);
		let queued: Buffer[] = [];
		client.on("data", (chunk: Buffer) => queued.push(chunk));
		upstream.on("data", chunk => client.write(chunk));
		for (let [from, to] of [[client, upstream], [upstream, client]] as const) {
			from.on("error", () => {});
			from.on("close", () => to.destroy());
		}
		timers.push(setInterval(() => {
			let head = queued[0];
			if (!head) return;
			let chunk = head.subarray(0, bytes);
			upstream.write(chunk);
			uploaded += chunk.length;
			if (head.length > bytes) queued[0] = head.subarray(bytes);
			else queued.shift();
		}, everyMs));
	});
	await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
		get uploaded() {
			return uploaded;
		},
		stop: () => {
			for (let timer of timers) clearInterval(timer);
			for (let socket of sockets) socket.destroy();
			return new Promise<void>(resolve => proxy.close(() => resolve()));
		},
	};
}

/**
 * A TCP proxy to `url` that forwards both ways until `hold()`, then keeps reading
 * what the server sends, one read every `everyMs`, and forwards none of it, as a
 * buffering proxy in front of a client that went quiet. The server's queue keeps
 * shrinking although the client reads and answers nothing.
 */
export async function holdingProxy(url: string, everyMs: number) {
	let target = new URL(url);
	let sockets: Socket[] = [];
	let timers: ReturnType<typeof setInterval>[] = [];
	let held = false;
	let swallowed = 0;
	let proxy = createServer(client => {
		let upstream = createConnection(Number(target.port), target.hostname);
		sockets.push(client, upstream);
		client.on("data", chunk => upstream.write(chunk));
		upstream.on("data", (chunk: Buffer) => {
			if (!held) return void client.write(chunk);
			swallowed += chunk.length;
			upstream.pause();
		});
		for (let [from, to] of [[client, upstream], [upstream, client]] as const) {
			from.on("error", () => {});
			from.on("close", () => to.destroy());
		}
		timers.push(setInterval(() => {
			if (held) upstream.resume();
		}, everyMs));
	});
	await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
		/** From now on the server's bytes are read slowly and dropped. */
		hold() {
			held = true;
			for (let socket of sockets) socket.pause();
		},
		/** Server bytes read and dropped since `hold()`. */
		get swallowed() {
			return swallowed;
		},
		stop: () => {
			for (let timer of timers) clearInterval(timer);
			for (let socket of sockets) socket.destroy();
			return new Promise<void>(resolve => proxy.close(() => resolve()));
		},
	};
}

/** Ends a scripted turn the way a model's last step does. */
export function finishTurn(context: TurnContext): void {
	let usage = { inputTokens: {}, outputTokens: {} };
	context.emit({ type: "finish-step", finishReason: { unified: "stop" }, usage });
	context.emit({ type: "finish", finishReason: { unified: "stop" }, totalUsage: usage });
}

/**
 * The scripted test client: a fake model that answers the prompts the harness
 * contract and the link tests send.
 */
export function scriptedPlanner(overrides: Partial<AgentHandlers> = {}) {
	let turns: TurnContext["message"][] = [];
	let destroyed: string[] = [];
	let handlers: AgentHandlers = {
		async turn(context) {
			turns.push(context.message);
			context.emit({ type: "stream-start", modelId: "scripted" });
			let prompt = context.message.prompt;
			if (prompt === "abort" || prompt === "hang") {
				if (!context.signal.aborted) {
					await new Promise(resolve => {
						context.signal.addEventListener("abort", resolve, { once: true });
					});
				}
				return;
			}
			if (prompt === "tools") {
				for (let tool of context.message.tools) await context.callHostTool(tool.name, {});
			}
			if (prompt === "output") {
				context.emit({ type: "text-start", id: "answer" });
				context.emit({ type: "text-delta", id: "answer", delta: '{"answer":"yes"}' });
				context.emit({ type: "text-end", id: "answer" });
			}
			finishTurn(context);
		},
		destroy(message) {
			destroyed.push(message.session);
		},
		...overrides,
	};
	return { handlers, turns, destroyed };
}

export function attach(
	url: string,
	document: string,
	handlers: AgentHandlers,
	token = MEMBER_TOKEN,
): Promise<AgentClient> {
	return connectAgent({ url, token, document, handlers });
}

/**
 * The same scripted client run by Node.js from the wire-only client module, or
 * undefined when no Node.js with built-in TypeScript stripping is installed.
 */
export async function nodeClient(url: string, document: string) {
	let node = Bun.which("node");
	if (!node) return undefined;
	let probe = Bun.spawnSync([node, "-p", "Boolean(process.features.typescript)"]);
	if (probe.stdout.toString().trim() !== "true") return undefined;
	let child = Bun.spawn([
		node,
		new URL("./agent-link-node-client.mjs", import.meta.url).pathname,
		url,
		MEMBER_TOKEN,
		document,
	], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	let reader = child.stdout.getReader();
	let { value } = await reader.read();
	reader.releaseLock();
	let line = JSON.parse(new TextDecoder().decode(value).trim()) as {
		attached: string;
		node: string;
	};
	return {
		...line,
		async stop() {
			child.stdin.end();
			await Promise.race([child.exited, Bun.sleep(2_000)]);
			child.kill();
		},
	};
}
