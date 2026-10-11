import { connectPlannerLink, linkSocket, plannerLinkUrl } from "@chopin/planner-link/client";

import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";
import { Sessions } from "../auth/session";
import { PlannerAttachments } from "../harness/remote/attachments";
import { admitPlannerLink, openPlannerLinkSocket } from "../harness/remote/endpoint";
import { MemoryStorage } from "../storage/memory/adapter";

import type {
	PlannerLinkClient,
	PlannerLinkHandlers,
	TurnContext,
} from "@chopin/planner-link/client";
import type { Repository } from "../github/client";
import type { AttachmentAuth } from "../harness/remote/attachments";
import type { PlannerLinkAuth, PlannerLinkSocketData } from "../harness/remote/endpoint";
import type { PlannerLink } from "../harness/remote/link";

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

function scoreRepository(owner: string, name: string, push: boolean): Repository {
	return {
		id: "R_score",
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
				let account = ACCOUNTS[token];
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
				let account = ACCOUNTS[token];
				if (!account) throw new GitHubError("Not Found", 404);
				return scoreRepository(owner, name, account.push);
			},
			async repositoryAccess(token: string, owner: string, name: string) {
				let account = Object.values(ACCOUNTS).find(value => loginToken(value.login) === token);
				return account ? scoreRepository(owner, name, account.push) : undefined;
			},
		},
	};
	return {
		auth: auth as unknown as PlannerLinkAuth & AttachmentAuth & { github: typeof auth.github },
		storage,
		sessions,
		logins,
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

/** A Bun server that serves only the Planner link, as the Chopin server does under HARNESS=remote. */
export function linkServer(
	auth: PlannerLinkAuth & AttachmentAuth,
	timeoutMs = 2_000,
	revalidateEveryMs?: number,
	graceMs = 2_000,
) {
	let links: PlannerLink[] = [];
	let attachments = new PlannerAttachments(auth, graceMs);
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
					attachments,
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
		attachments,
		get links() {
			return links;
		},
		stop: () => {
			attachments.close();
			return server.stop(true);
		},
	};
}

/** Raw frames over a socket that authenticated as the member, for protocol violations. */
export async function rawLink(url: string, token = MEMBER_TOKEN) {
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
	token = MEMBER_TOKEN,
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
