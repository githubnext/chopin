import { connectPlannerLink, linkSocket, plannerLinkUrl } from "@chopin/planner-link/client";

import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";
import { admitPlannerLink, openPlannerLinkSocket } from "../harness/remote/endpoint";
import { MemoryStorage } from "../storage/memory/adapter";

import type {
	PlannerLinkClient,
	PlannerLinkHandlers,
	TurnContext,
} from "@chopin/planner-link/client";
import type { Repository } from "../github/client";
import type { PlannerLinkAuth, PlannerLinkSocketData } from "../harness/remote/endpoint";
import type { PlannerLink } from "../harness/remote/link";

export const READER_TOKEN = "reader-token";
export const OUTSIDER_TOKEN = "outsider-token";
export const DENIED_TOKEN = "denied-token";

/**
 * GitHub as hosted MCP sees it: the reader can pull `octo-org/score`, the
 * outsider is a valid account without access, the denied account fails
 * admission, and every other token is rejected by GitHub.
 */
export async function linkAuth(channelId?: string) {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "U_reader", login: "reader", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: channelId ?? crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Linked document",
		createdBy: "U_reader",
		now,
	});
	let auth = {
		config: { origin: "https://chopin.test" },
		storage,
		admission: {
			async user(token: string) {
				if (token === DENIED_TOKEN) throw new AdmissionDenied();
				if (token === READER_TOKEN) return { id: "U_reader", login: "reader", avatarUrl: "" };
				if (token === OUTSIDER_TOKEN) return { id: "U_outsider", login: "outsider", avatarUrl: "" };
				throw new GitHubError("Bad credentials", 401);
			},
		},
		github: {
			async repository(token: string, owner: string, name: string): Promise<Repository> {
				if (token !== READER_TOKEN) throw new GitHubError("Not Found", 404);
				return {
					id: "R_score",
					owner,
					name,
					fullName: `${owner}/${name}`,
					private: true,
					url: `https://github.test/${owner}/${name}`,
					defaultBranch: "main",
					permissions: { pull: true, push: false, admin: false },
				};
			},
		},
	} as unknown as PlannerLinkAuth;
	return { auth, storage, channel };
}

/** A Bun server that serves only the Planner link, as the Chopin server does under HARNESS=remote. */
export function linkServer(auth: PlannerLinkAuth, timeoutMs = 2_000, revalidateEveryMs?: number) {
	let links: PlannerLink[] = [];
	let server = Bun.serve<PlannerLinkSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, self) {
			let outcome = await admitPlannerLink(request, auth);
			if (outcome instanceof Response) return outcome;
			return self.upgrade(request, { data: outcome })
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				openPlannerLinkSocket(ws, auth, {
					timeoutMs,
					revalidateEveryMs,
					register(_channelId, link) {
						links.push(link);
						return () => {
							links = links.filter(candidate => candidate !== link);
						};
					},
				});
			},
			message(ws, raw) {
				ws.data.link?.receive(raw);
			},
			close(ws) {
				ws.data.link?.disconnected();
			},
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		get links() {
			return links;
		},
		stop: () => server.stop(true),
	};
}

/** Raw frames over a socket that authenticated as the reader, for protocol violations. */
export async function rawLink(url: string, token = READER_TOKEN) {
	let socket = linkSocket(plannerLinkUrl(url), token);
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
export function scriptedPlanner(overrides: Partial<PlannerLinkHandlers> = {}) {
	let turns: TurnContext["message"][] = [];
	let destroyed: string[] = [];
	let handlers: PlannerLinkHandlers = {
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
	handlers: PlannerLinkHandlers,
	token = READER_TOKEN,
): Promise<PlannerLinkClient> {
	return connectPlannerLink({ url, token, document, handlers });
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
		new URL("./planner-link-node-client.mjs", import.meta.url).pathname,
		url,
		READER_TOKEN,
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
