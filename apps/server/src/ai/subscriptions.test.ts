import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { AI_LAUNCH_HEADER } from "@chopin/protocol/ai-credentials";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { AiCredentials } from "./credentials";
import { aiProxy, claudeSignInBody } from "./proxy";
import { githubSignIn, registerAiRoutes } from "./routes";

import type {
	AiCredentialSummary,
	AiProviderGrant,
	AiSignInStart,
} from "@chopin/protocol/ai-credentials";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant } from "../github/client";

const ORIGIN = "https://chopin.test";
const OPENAI_KEY = "sk-real-openai-key-0123456789";
const CHATGPT_SCOPE =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CLAUDE_CODE_IDENTITY = {
	type: "text",
	text: "You are Claude Code, Anthropic's official CLI for Claude.",
};

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

/** A server standing in for one on the internet: it records each request it is sent. */
function fake(answer: (request: Request, body: string) => Response | Promise<Response>) {
	let seen: Seen[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let url = new URL(request.url);
			let body = await request.text();
			seen.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers: Object.fromEntries(request.headers),
				body,
			});
			return answer(request, body);
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, seen };
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "ghr_user",
		refreshExpiresIn: 15_897_600,
	};
}

function answer() {
	return Response.json({ ok: true });
}

/** The address ChatGPT sends the browser to once `url`'s sign-in is approved. */
function chatgptCallback(url: URL, code = "chatgpt-code", clientId = "app_issued") {
	return `http://127.0.0.1:1455/auth/callback?code=${code}&scope=x&state=${
		url.searchParams.get("state")
	}&client_id=${clientId}`;
}

type TokenReply = (fields: Record<string, string>) => Response | Promise<Response>;

async function setup() {
	let now = new Date("2026-10-09T12:00:00.000Z");
	let clock = () => now;
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "avatar", now });
	let lease = await testLease(storage);
	let github = {
		user: async () => ({ id: "U_mona", login: "mona", avatarUrl: "avatar" }),
		organizationMembership: async () => undefined,
		invalidate() {},
	} as unknown as GitHub;
	let config = {
		origin: ORIGIN,
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: new Uint8Array(32).fill(5),
	};
	let sessions = new Sessions(storage, true, clock, { refresh: async () => grant("ghu_again") });
	let mona = (await sessions.issue("U_mona", grant("ghu_mona"))).cookie.split(";")[0]!;
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		machines: new Machines(storage, clock, {
			origin: ORIGIN,
			clientId: "client-id",
			key: new Uint8Array(32).fill(9),
			refresh: async () => grant("ghu_machine"),
			lease: () => lease,
		}),
		pairings: {},
		clock,
	};
	let issued = 0;
	let chatgptReply: { current?: TokenReply } = {};
	let claudeReply: { current?: TokenReply } = {};
	let tokens = (provider: string, extra: Record<string, unknown> = {}) => {
		issued++;
		return Response.json({
			access_token: `${provider}-access-${issued}`,
			refresh_token: `${provider}-refresh-${issued}`,
			expires_in: 3600,
			...extra,
		});
	};
	let chatgptAuth = fake((_request, body) => {
		let fields = Object.fromEntries(new URLSearchParams(body));
		return chatgptReply.current?.(fields)
			?? tokens("chatgpt", { id_token: "chatgpt-id", scope: CHATGPT_SCOPE });
	});
	let claudeAuth = fake((_request, body) => {
		let fields = JSON.parse(body) as Record<string, string>;
		return claudeReply.current?.(fields) ?? tokens("claude");
	});
	let refusals = { claude: 0 };
	let upstreams = {
		openai: fake(answer),
		anthropic: fake(answer),
		chatgpt: fake(answer),
		claude: fake(() => {
			if (refusals.claude <= 0) return answer();
			refusals.claude--;
			return Response.json({
				type: "error",
				error: { type: "authentication_error", message: "OAuth token has expired." },
			}, { status: 401 });
		}),
		copilot: fake(answer),
	};
	let keyChecks = fake(() => Response.json({ data: [] }));
	let credentialOptions: ConstructorParameters<typeof AiCredentials>[0] = {
		storage,
		key: config.encryptionKey,
		origin: ORIGIN,
		clock,
		githubToken: githubSignIn(auth),
		copilotToken: async () => undefined,
		upstreams: { openai: keyChecks.url, anthropic: keyChecks.url },
		signIns: {
			chatgpt: { token: `${chatgptAuth.url}/api/accounts/oauth/token` },
			claude: { token: `${claudeAuth.url}/v1/oauth/token` },
		},
		lease: () => lease,
	};
	let credentials = new AiCredentials(credentialOptions);
	let launchTokens = new Map<string, string>();
	let router = new Router();
	registerAiRoutes(router, auth, {
		credentials,
		proxy: aiProxy({
			credentials,
			upstreams: {
				openai: upstreams.openai.url,
				anthropic: upstreams.anthropic.url,
				chatgpt: upstreams.chatgpt.url,
				claude: upstreams.claude.url,
				"github-copilot": upstreams.copilot.url,
			},
		}),
	});
	let api = (path: string, init: RequestInit = {}) =>
		router.handle(
			new Request(`${ORIGIN}${path}`, {
				...init,
				headers: { cookie: mona, origin: ORIGIN, ...init.headers },
			}),
		) as Promise<Response>;
	let start = async (provider: "chatgpt" | "claude") => {
		let response = await api(`/api/ai/sign-ins/${provider}`, { method: "POST" });
		expect(response.status).toBe(200);
		return new URL(((await response.json()) as AiSignInStart).url);
	};
	let finish = (provider: "chatgpt" | "claude", input: string) =>
		api(`/api/ai/sign-ins/${provider}/finish`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
		});
	let signInChatgpt = async () => {
		let url = await start("chatgpt");
		let response = await finish("chatgpt", chatgptCallback(url));
		expect(response.status).toBe(200);
	};
	let signInClaude = async () => {
		let url = await start("claude");
		let response = await finish("claude", `claude-code#${url.searchParams.get("state")}`);
		expect(response.status).toBe(200);
	};
	let launch = async () => {
		let launched = await credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(now.getTime() + 86_400_000),
		});
		for (let value of launched.grants) launchTokens.set(value.placeholder, launched.launchToken);
		return Object.fromEntries(launched.grants.map(value => [value.provider, value]));
	};
	let call = (
		value: AiProviderGrant,
		path: string,
		headers: Record<string, string> = {},
		body: unknown = { model: "a-model" },
	) =>
		router.handle(
			new Request(`${value.baseUrl}${path}`, {
				method: "POST",
				headers: {
					[AI_LAUNCH_HEADER]: launchTokens.get(value.placeholder)!,
					"content-type": "application/json",
					...headers,
				},
				body: JSON.stringify(body),
			}),
		) as Promise<Response>;
	let list = async () =>
		((await (await api("/api/ai/credentials")).json()) as { credentials: AiCredentialSummary[] })
			.credentials;
	return {
		storage,
		credentials,
		chatgptAuth,
		claudeAuth,
		chatgptReply,
		claudeReply,
		upstreams,
		refusals,
		api,
		start,
		finish,
		chatgptCallback,
		signInChatgpt,
		signInClaude,
		launch,
		call,
		list,
		restarted: () => new AiCredentials(credentialOptions),
		advance(ms: number) {
			now = new Date(now.getTime() + ms);
		},
		now: () => now,
	};
}

/** Answers refreshes as a provider that rotates refresh tokens does: a spent one is refused. */
function rotating(provider: string, extra: Record<string, string> = {}): TokenReply {
	let spent = new Set<string>();
	let issued = 0;
	return fields => {
		if (spent.has(fields.refresh_token!)) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		spent.add(fields.refresh_token!);
		issued++;
		return Response.json({
			access_token: `${provider}-renewed-${issued}`,
			refresh_token: `${provider}-rotated-${issued}`,
			expires_in: 3600,
			...extra,
		});
	};
}

function challengeOf(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

describe("Sign in with ChatGPT", () => {
	it("sends the person to OpenAI's agent sign-in and exchanges the pasted callback for tokens", async () => {
		let world = await setup();
		let url = await world.start("chatgpt");
		expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/api/accounts/authorize");
		let params = Object.fromEntries(url.searchParams);
		expect(params).toMatchObject({
			client_id: "dynamic_agent_client",
			agent_name_hint: "Chopin",
			response_type: "code",
			redirect_uri: "http://127.0.0.1:1455/auth/callback",
			resource: "https://api.openai.com/v1",
			scope: CHATGPT_SCOPE,
			code_challenge_method: "S256",
		});
		expect(params.ext_agent_host_id).toMatch(
			/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(params.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(params.nonce).not.toBe(params.state);

		let response = await world.finish("chatgpt", world.chatgptCallback(url));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			provider: "chatgpt",
			kind: "subscription",
			updatedAt: world.now().toISOString(),
		});
		let [exchange] = world.chatgptAuth.seen;
		expect(exchange!.path).toBe("/api/accounts/oauth/token");
		expect(exchange!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
		let fields = Object.fromEntries(new URLSearchParams(exchange!.body));
		expect(fields).toMatchObject({
			grant_type: "authorization_code",
			client_id: "app_issued",
			code: "chatgpt-code",
			redirect_uri: "http://127.0.0.1:1455/auth/callback",
			resource: "https://api.openai.com/v1",
		});
		expect(challengeOf(fields.code_verifier!)).toBe(params.code_challenge!);

		let listed = await (await world.api("/api/ai/credentials")).text();
		expect(listed).not.toContain("chatgpt-access");
		expect(listed).not.toContain("chatgpt-refresh");
		let stored = await world.storage.aiCredentials.get("U_mona", "chatgpt");
		expect(Buffer.from(stored!.ciphertext!).toString("latin1")).not.toContain("chatgpt-access");
	});

	it("refuses a paste that isn't this sign-in's callback, sending nothing and keeping the sign-in", async () => {
		let world = await setup();
		let url = await world.start("chatgpt");
		let state = url.searchParams.get("state");
		let refusals = [
			["not an address", "Paste the full address your browser opened after you signed in."],
			[
				`https://evil.test/auth/callback?code=c&state=${state}&client_id=app`,
				"The address you paste starts with http://127.0.0.1:1455/auth/callback.",
			],
			[
				`http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`,
				"ChatGPT didn't finish signing you in (access_denied). Start again.",
			],
			[
				"http://127.0.0.1:1455/auth/callback?code=c&state=another&client_id=app",
				"This address is from another sign-in. Paste the one from the sign-in you just opened.",
			],
			[
				`http://127.0.0.1:1455/auth/callback?code=c&state=${state}`,
				"This address has no client ID from ChatGPT. Start again.",
			],
		];
		for (let [input, message] of refusals) {
			let response = await world.finish("chatgpt", input!);
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({ error: message });
		}
		expect(world.chatgptAuth.seen).toHaveLength(0);
		expect(await world.storage.aiCredentials.get("U_mona", "chatgpt")).toBeUndefined();
		expect((await world.finish("chatgpt", world.chatgptCallback(url))).status).toBe(200);
	});

	it("keeps what was connected when OpenAI refuses, answers without a direct token, or can't be reached", async () => {
		let world = await setup();
		await world.signInChatgpt();
		let connected = await world.storage.aiCredentials.get("U_mona", "chatgpt");
		let cases: Array<[() => Response, number, string]> = [
			[
				() => Response.json({ error: "invalid_grant" }, { status: 400 }),
				422,
				"ChatGPT didn't accept this sign-in. Start again.",
			],
			[
				() => new Response("down", { status: 503 }),
				502,
				"ChatGPT couldn't finish signing you in just now. Start again in a moment.",
			],
			[
				() =>
					Response.json({
						access_token: "a",
						refresh_token: "r",
						id_token: "i",
						expires_in: 3600,
						scope: "openid",
					}),
				422,
				"ChatGPT answered without everything Chopin needs. Start again.",
			],
		];
		for (let [reply, status, message] of cases) {
			world.chatgptReply.current = reply;
			let url = await world.start("chatgpt");
			let response = await world.finish("chatgpt", world.chatgptCallback(url));
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: message, restart: true });
			// The code was spent: the same answer again starts nothing.
			let again = await world.finish("chatgpt", world.chatgptCallback(url));
			expect(await again.json()).toEqual({
				error: "This ChatGPT sign-in has ended. Start it again.",
				restart: true,
			});
		}
		expect(await world.storage.aiCredentials.get("U_mona", "chatgpt")).toEqual(connected);
	});

	it("lets a sign-in lapse after fifteen minutes", async () => {
		let world = await setup();
		let url = await world.start("chatgpt");
		world.advance(15 * 60_000);
		let response = await world.finish("chatgpt", world.chatgptCallback(url));
		expect(response.status).toBe(422);
		expect((await response.json() as { restart?: boolean }).restart).toBe(true);
		expect(world.chatgptAuth.seen).toHaveLength(0);
	});
});

describe("Claude's sign-in", () => {
	it("opens Claude's authorize page with the copy-the-code redirect and exchanges the pasted code", async () => {
		let world = await setup();
		let url = await world.start("claude");
		expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
		let params = Object.fromEntries(url.searchParams);
		expect(params).toMatchObject({
			code: "true",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			response_type: "code",
			redirect_uri: "https://platform.claude.com/oauth/code/callback",
			scope:
				"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
			code_challenge_method: "S256",
		});
		expect(challengeOf(params.state!)).toBe(params.code_challenge!);

		let response = await world.finish("claude", `the-code#${params.state}`);
		expect(response.status).toBe(200);
		let [exchange] = world.claudeAuth.seen;
		expect(exchange!.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(exchange!.body)).toEqual({
			grant_type: "authorization_code",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			code: "the-code",
			state: params.state,
			redirect_uri: "https://platform.claude.com/oauth/code/callback",
			code_verifier: params.state,
		});
	});

	it("takes a bare code, refuses another sign-in's, and keeps the connected one when Anthropic refuses", async () => {
		let world = await setup();
		let url = await world.start("claude");
		let mismatched = await world.finish("claude", "the-code#another-state");
		expect(mismatched.status).toBe(422);
		expect(world.claudeAuth.seen).toHaveLength(0);
		expect((await world.finish("claude", "bare-code")).status).toBe(200);
		expect(JSON.parse(world.claudeAuth.seen[0]!.body).state).toBe(url.searchParams.get("state"));

		let connected = await world.storage.aiCredentials.get("U_mona", "claude");
		world.claudeReply.current = () => Response.json({ error: "invalid_grant" }, { status: 400 });
		let again = await world.start("claude");
		let refused = await world.finish("claude", `code#${again.searchParams.get("state")}`);
		expect(refused.status).toBe(422);
		expect(await refused.json()).toEqual({
			error: "Claude didn't accept this sign-in. Start again.",
			restart: true,
		});
		expect(await world.storage.aiCredentials.get("U_mona", "claude")).toEqual(connected);
	});

	it("takes no key for a subscription", async () => {
		let world = await setup();
		let response = await world.api("/api/ai/credentials/claude", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "api-key", secret: "sk-ant-api-0123456789" }),
		});
		expect(response.status).toBe(422);
		expect(await world.storage.aiCredentials.get("U_mona", "claude")).toBeUndefined();
	});
});

describe("a subscription's stand-ins", () => {
	it("send each credential only to its own provider, with the headers Atomic sends", async () => {
		let world = await setup();
		await world.signInChatgpt();
		await world.signInClaude();
		await world.api("/api/ai/credentials/openai", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "api-key", secret: OPENAI_KEY }),
		});
		let { chatgpt, claude, openai } = await world.launch();
		expect(chatgpt!.baseUrl).toBe(`${ORIGIN}/api/v1/ai/chatgpt/v1`);
		expect(chatgpt!.keyVariable).toBe("CHATGPT_ACCESS_TOKEN");
		expect(claude!.baseUrl).toBe(`${ORIGIN}/api/v1/ai/claude`);
		expect(claude!.keyVariable).toBe("CLAUDE_CODE_OAUTH_TOKEN");
		expect(claude!.placeholder).toMatch(/^chopin_ai_sk-ant-oat01-[A-Za-z0-9_-]{30}$/);

		expect(
			(await world.call(chatgpt!, "/responses", {
				authorization: `Bearer ${chatgpt!.placeholder}`,
			}))
				.status,
		).toBe(200);
		expect(
			(await world.call(claude!, "/v1/messages", {
				authorization: `Bearer ${claude!.placeholder}`,
				"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
				"user-agent": "some-agent/1.0",
				"anthropic-version": "2023-06-01",
			})).status,
		).toBe(200);
		expect(
			(await world.call(openai!, "/responses", { authorization: `Bearer ${openai!.placeholder}` }))
				.status,
		).toBe(200);

		let [toChatgpt] = world.upstreams.chatgpt.seen;
		expect(toChatgpt!.path).toBe("/v1/responses");
		expect(toChatgpt!.headers.authorization).toBe("Bearer chatgpt-access-1");
		expect(toChatgpt!.headers["x-api-key"]).toBeUndefined();
		expect(toChatgpt!.headers[AI_LAUNCH_HEADER]).toBeUndefined();

		let [toClaude] = world.upstreams.claude.seen;
		expect(toClaude!.path).toBe("/v1/messages");
		expect(toClaude!.headers.authorization).toBe("Bearer claude-access-2");
		expect(toClaude!.headers["x-api-key"]).toBeUndefined();
		expect(toClaude!.headers["anthropic-beta"]).toBe(
			"claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
		);
		expect(toClaude!.headers["user-agent"]).toBe("claude-cli/2.1.322");
		expect(toClaude!.headers["x-app"]).toBe("cli");
		expect(toClaude!.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
		expect(toClaude!.headers["anthropic-version"]).toBe("2023-06-01");
		expect(JSON.parse(toClaude!.body)).toEqual({
			model: "a-model",
			system: [CLAUDE_CODE_IDENTITY],
		});

		expect(world.upstreams.openai.seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
		let everywhere = JSON.stringify([
			world.upstreams.openai.seen,
			world.upstreams.anthropic.seen,
			world.upstreams.copilot.seen,
		]);
		expect(everywhere).not.toContain("chatgpt-access");
		expect(everywhere).not.toContain("claude-access");
		expect(JSON.stringify(world.upstreams.chatgpt.seen)).not.toContain(OPENAI_KEY);
		expect(JSON.stringify(world.upstreams.claude.seen)).not.toContain("chatgpt-access");

		let wrong = await world.call(claude!, "/v1/complete", {
			authorization: `Bearer ${claude!.placeholder}`,
		});
		expect(wrong.status).toBe(404);
		let other = await world.call(
			{ ...claude!, baseUrl: `${ORIGIN}/api/v1/ai/anthropic` },
			"/v1/messages",
			{
				authorization: `Bearer ${claude!.placeholder}`,
			},
		);
		expect(other.status).toBe(401);
		expect(world.upstreams.anthropic.seen).toHaveLength(0);
	});

	it("refresh the access token before it is sent past its expiry, once for concurrent requests", async () => {
		let world = await setup();
		await world.signInChatgpt();
		let { chatgpt } = await world.launch();
		let headers = { authorization: `Bearer ${chatgpt!.placeholder}` };
		world.advance(3600_000 - 3 * 60_000 - 1);
		await world.call(chatgpt!, "/responses", headers);
		expect(world.upstreams.chatgpt.seen.at(-1)!.headers.authorization).toBe(
			"Bearer chatgpt-access-1",
		);
		expect(world.chatgptAuth.seen).toHaveLength(1);

		world.advance(1);
		let release = Promise.withResolvers<void>();
		world.chatgptReply.current = async fields => {
			await release.promise;
			expect(fields).toMatchObject({
				grant_type: "refresh_token",
				client_id: "app_issued",
				refresh_token: "chatgpt-refresh-1",
				resource: "https://api.openai.com/v1",
			});
			return Response.json({ access_token: "chatgpt-access-renewed", scope: CHATGPT_SCOPE });
		};
		let both = Promise.all([
			world.call(chatgpt!, "/responses", headers),
			world.call(chatgpt!, "/responses", headers),
		]);
		await Bun.sleep(20);
		release.resolve();
		expect((await both).map(response => response.status)).toEqual([200, 200]);
		expect(world.chatgptAuth.seen).toHaveLength(2);
		expect(world.upstreams.chatgpt.seen.slice(-2).map(seen => seen.headers.authorization))
			.toEqual(["Bearer chatgpt-access-renewed", "Bearer chatgpt-access-renewed"]);
		let stored = await world.storage.aiCredentials.get("U_mona", "chatgpt");
		expect(stored!.tokens).toBeDefined();
		let summary = (await world.list()).find(value => value.provider === "chatgpt");
		expect(summary).toMatchObject({ provider: "chatgpt", kind: "subscription" });
		expect(summary!.unchecked).toBeUndefined();
		expect(summary!.rejectedAt).toBeUndefined();
	});

	it("renew a Claude token the provider refused before its next use", async () => {
		let world = await setup();
		await world.signInClaude();
		let { claude } = await world.launch();
		let headers = { authorization: `Bearer ${claude!.placeholder}` };
		world.refusals.claude = 1;
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(401);
		expect(world.claudeAuth.seen).toHaveLength(1);
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(200);
		expect(JSON.parse(world.claudeAuth.seen.at(-1)!.body)).toEqual({
			grant_type: "refresh_token",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			refresh_token: "claude-refresh-1",
		});
		expect(world.upstreams.claude.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer claude-access-1",
			"Bearer claude-access-2",
		]);
		let listed = (await world.list()).find(value => value.provider === "claude")!;
		expect(listed.rejectedAt).toBeUndefined();
	});

	it("keep the current token refused when a refusal of an older one arrives late", async () => {
		let world = await setup();
		await world.signInClaude();
		let first = (await world.storage.aiCredentials.get("U_mona", "claude"))!;
		let { claude } = await world.launch();
		let headers = { authorization: `Bearer ${claude!.placeholder}` };
		world.refusals.claude = 1;
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(401);
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(200);
		world.refusals.claude = 1;
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(401);

		await world.credentials.rejected(first, "claude-access-1");
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(200);
		expect(world.upstreams.claude.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer claude-access-1",
			"Bearer claude-access-2",
			"Bearer claude-access-2",
			"Bearer claude-access-3",
		]);
		expect(world.claudeAuth.seen.slice(1).map(seen => JSON.parse(seen.body).refresh_token))
			.toEqual(["claude-refresh-1", "claude-refresh-2"]);
	});

	it("keep a refused token refused across a restart, renewing it before it is sent or listed", async () => {
		let world = await setup();
		await world.signInChatgpt();
		let { chatgpt } = await world.launch();
		let headers = { authorization: `Bearer ${chatgpt!.placeholder}` };
		let record = (await world.storage.aiCredentials.get("U_mona", "chatgpt"))!;
		await world.credentials.rejected(record, "chatgpt-access-1");
		expect(world.chatgptAuth.seen).toHaveLength(1);

		let restarted = world.restarted();
		world.chatgptReply.current = () => new Response("unavailable", { status: 503 });
		let unchecked = (await restarted.list("U_mona")).find(value => value.provider === "chatgpt")!;
		expect(unchecked.unchecked).toBe(true);
		let launched = await restarted.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 60_000),
		});
		expect(launched.withheld).toContainEqual({ provider: "chatgpt", reason: "renew-unavailable" });

		world.chatgptReply.current = undefined;
		let listed = (await restarted.list("U_mona")).find(value => value.provider === "chatgpt")!;
		expect(listed.unchecked).toBeUndefined();
		expect(listed.rejectedAt).toBeUndefined();
		expect(
			world.chatgptAuth.seen.slice(1).map(seen =>
				new URLSearchParams(seen.body).get("refresh_token")
			),
		).toEqual(["chatgpt-refresh-1", "chatgpt-refresh-1", "chatgpt-refresh-1"]);
		expect((await world.call(chatgpt!, "/responses", headers)).status).toBe(200);
		expect(world.upstreams.chatgpt.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer chatgpt-access-2",
		]);
	});

	it("never send a stale token: a refused renewal needs signing in again, a failed one couldn't be checked", async () => {
		let world = await setup();
		await world.signInClaude();
		let { claude } = await world.launch();
		let headers = { authorization: `Bearer ${claude!.placeholder}` };
		world.advance(3600_000);

		world.claudeReply.current = () => new Response("unavailable", { status: 503 });
		let failed = await world.call(claude!, "/v1/messages", headers);
		expect(failed.status).toBe(502);
		expect((await failed.json() as { error: { code: string } }).error.code).toBe(
			"renew-unavailable",
		);
		expect((await world.list()).find(value => value.provider === "claude")!.unchecked).toBe(true);
		expect((await world.credentials.available("U_mona")).withheld).toEqual([
			{ provider: "github-copilot", reason: "no-copilot-access" },
		]);
		let unchecked = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 60_000),
		});
		expect(unchecked.withheld).toContainEqual({ provider: "claude", reason: "renew-unavailable" });

		world.claudeReply.current = () => Response.json({ error: "invalid_grant" }, { status: 400 });
		let refused = await world.call(claude!, "/v1/messages", headers);
		expect(refused.status).toBe(403);
		expect((await refused.json() as { error: { code: string } }).error.code).toBe(
			"sign-in-ended",
		);
		expect(world.upstreams.claude.seen).toHaveLength(0);
		let listed = (await world.list()).find(value => value.provider === "claude")!;
		expect(listed.rejectedAt).toBe(world.now().toISOString());
		expect(listed.unchecked).toBeUndefined();
		let ended = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 60_000),
		});
		expect(ended.withheld).toContainEqual({ provider: "claude", reason: "key-unusable" });
		expect(ended.grants.map(value => value.provider)).not.toContain("claude");
	});

	it("give a caller that read the pair before another renewed it the renewed pair, never the spent refresh token", async () => {
		let world = await setup();
		await world.signInClaude();
		let { claude } = await world.launch();
		let headers = { authorization: `Bearer ${claude!.placeholder}` };
		world.claudeReply.current = rotating("claude");
		world.advance(3600_000);

		let store = world.storage.aiCredentials;
		let list = store.list.bind(store);
		let reached = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		store.list = async userId => {
			let records = await list(userId);
			store.list = list;
			reached.resolve();
			await release.promise;
			return records;
		};
		let listing = world.list();
		await reached.promise;
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(200);
		release.resolve();
		let listed = (await listing).find(value => value.provider === "claude")!;

		expect(listed.rejectedAt).toBeUndefined();
		expect(listed.unchecked).toBeUndefined();
		expect(world.claudeAuth.seen.slice(1).map(seen => JSON.parse(seen.body).refresh_token))
			.toEqual(["claude-refresh-1"]);
		expect((await world.call(claude!, "/v1/messages", headers)).status).toBe(200);
		expect(world.upstreams.claude.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer claude-renewed-1",
			"Bearer claude-renewed-1",
		]);
	});

	it("mark a refused renewal only on the pair it presented, never on one renewed since", async () => {
		let world = await setup();
		await world.signInClaude();
		let before = (await world.storage.aiCredentials.get("U_mona", "claude"))!;
		let { claude } = await world.launch();
		world.claudeReply.current = rotating("claude");
		world.advance(3600_000);
		expect(
			(await world.call(claude!, "/v1/messages", {
				authorization: `Bearer ${claude!.placeholder}`,
			})).status,
		).toBe(200);
		expect(await world.storage.aiCredentials.rejected(before, world.now())).toBe(false);
		let stored = (await world.storage.aiCredentials.get("U_mona", "claude"))!;
		expect(stored.rejectedAt).toBeUndefined();
	});

	it("keep a renewed pair storage couldn't save, and save it before renewing again", async () => {
		let world = await setup();
		await world.signInChatgpt();
		let { chatgpt } = await world.launch();
		let headers = { authorization: `Bearer ${chatgpt!.placeholder}` };
		world.chatgptReply.current = rotating("chatgpt", { scope: CHATGPT_SCOPE });
		world.advance(3600_000);

		let store = world.storage.aiCredentials;
		let refreshed = store.refreshed.bind(store);
		let failures = 2;
		store.refreshed = async (...args) => {
			if (failures > 0) {
				failures--;
				throw new Error("storage is unavailable");
			}
			return refreshed(...args);
		};
		expect((await world.call(chatgpt!, "/responses", headers)).status).toBe(200);
		expect((await world.call(chatgpt!, "/responses", headers)).status).toBe(200);
		expect((await store.get("U_mona", "chatgpt"))!.tokens).toBeUndefined();
		expect((await world.call(chatgpt!, "/responses", headers)).status).toBe(200);
		expect((await store.get("U_mona", "chatgpt"))!.tokens).toBeDefined();

		world.advance(3600_000);
		expect((await world.call(chatgpt!, "/responses", headers)).status).toBe(200);
		expect(
			world.chatgptAuth.seen.slice(1).map(seen =>
				new URLSearchParams(seen.body).get("refresh_token")
			),
		).toEqual(["chatgpt-refresh-1", "chatgpt-rotated-1"]);
		expect(world.upstreams.chatgpt.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer chatgpt-renewed-1",
			"Bearer chatgpt-renewed-1",
			"Bearer chatgpt-renewed-1",
			"Bearer chatgpt-renewed-2",
		]);
		let listed = (await world.list()).find(value => value.provider === "chatgpt")!;
		expect(listed.rejectedAt).toBeUndefined();
	});

	it("put the Claude Code identity first in any agent's Claude request, keeping its own system prompt", async () => {
		let world = await setup();
		await world.signInClaude();
		let { claude } = await world.launch();
		let headers = { authorization: `Bearer ${claude!.placeholder}` };
		let prompt = { type: "text", text: "You review code.", cache_control: { type: "ephemeral" } };
		await world.call(claude!, "/v1/messages", headers, {
			model: "a-model",
			system: "You review code.",
			messages: [{ role: "user", content: "Hi" }],
		});
		await world.call(claude!, "/v1/messages", headers, { model: "a-model", system: [prompt] });
		await world.call(claude!, "/v1/messages/count_tokens", headers, {
			model: "a-model",
			system: [CLAUDE_CODE_IDENTITY, prompt],
		});
		expect(world.upstreams.claude.seen.map(seen => JSON.parse(seen.body))).toEqual([
			{
				model: "a-model",
				system: [CLAUDE_CODE_IDENTITY, { type: "text", text: "You review code." }],
				messages: [{ role: "user", content: "Hi" }],
			},
			{ model: "a-model", system: [CLAUDE_CODE_IDENTITY, prompt] },
			{ model: "a-model", system: [CLAUDE_CODE_IDENTITY, prompt] },
		]);
	});

	it("leave a Claude body that isn't a JSON object as it came", () => {
		for (let text of ["not json", "[1]", '"text"', `{"system":{"type":"text"}}`]) {
			let body = new TextEncoder().encode(text);
			expect(claudeSignInBody(body)).toBe(body);
		}
	});

	it("stop at once for every launch when the subscription is disconnected", async () => {
		let world = await setup();
		await world.signInChatgpt();
		let first = (await world.launch()).chatgpt!;
		let second = (await world.launch()).chatgpt!;
		expect(
			(await world.api("/api/ai/credentials/chatgpt", { method: "DELETE" })).status,
		).toBe(204);
		for (let value of [first, second]) {
			let response = await world.call(value, "/responses", {
				authorization: `Bearer ${value.placeholder}`,
			});
			expect(response.status).toBe(403);
		}
		expect(world.upstreams.chatgpt.seen).toHaveLength(0);
	});
});
