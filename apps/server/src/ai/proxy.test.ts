import { afterEach, describe, expect, it } from "bun:test";

import { AI_KEY_VARIABLES } from "@chopin/protocol/ai-credentials";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { copilotEntitlement } from "./copilot";
import { AiCredentials } from "./credentials";
import { aiProxy } from "./proxy";
import { githubSignIn, registerAiRoutes } from "./routes";

import type { AiProviderGrant } from "@chopin/protocol/ai-credentials";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant } from "../github/client";

const ORIGIN = "https://chopin.test";
const OPENAI_KEY = "sk-real-openai-key-0123456789";
const ANTHROPIC_KEY = "sk-ant-real-anthropic-key-0123456789";
const OTHER_OPENAI_KEY = "sk-someone-elses-openai-key-0123456789";

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

/** A provider standing in for one on the internet: it records each request it is sent. */
function provider(
	answer: (request: Request) => Response | Promise<Response> = () =>
		Response.json({ ok: true }, { headers: { "set-cookie": "upstream=1" } }),
) {
	let seen: Seen[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let url = new URL(request.url);
			seen.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers: Object.fromEntries(request.headers),
				body: await request.text(),
			});
			return answer(request);
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, host: `127.0.0.1:${server.port}`, seen };
}

function grant(accessToken: string, accessExpiresIn = 28_800): GitHubTokenGrant {
	return { accessToken, accessExpiresIn, refreshToken: "ghr_user", refreshExpiresIn: 15_897_600 };
}

async function setup() {
	let now = new Date("2026-10-09T12:00:00.000Z");
	let clock = () => now;
	let storage = new MemoryStorage();
	for (let [id, login] of [["U_mona", "mona"], ["U_hubot", "hubot"]] as const) {
		await storage.users.put({ id, login, avatarUrl: "avatar", now });
	}
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
	let renewals = 0;
	let sessions = new Sessions(storage, true, clock, {
		refresh: async () => grant(`ghu_renewed_${++renewals}`),
	});
	let mona = (await sessions.issue("U_mona", grant("ghu_mona_signed_in"))).cookie.split(";")[0]!;
	let hubot = (await sessions.issue("U_hubot", grant("ghu_hubot"))).cookie.split(";")[0]!;
	let machines = new Machines(storage, clock, {
		origin: ORIGIN,
		clientId: "client-id",
		key: new Uint8Array(32).fill(9),
		refresh: async () => grant("ghu_machine_renewed"),
	});
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		machines,
		pairings: {},
		clock,
	};
	let upstreams = { openai: provider(), anthropic: provider(), copilot: provider() };
	let catalog = provider(() =>
		Response.json({ openai: { models: {} } }, { headers: { etag: '"v1"' } })
	);
	let entitled = new Map<string, number>();
	let githubApi = provider(request => {
		let token = request.headers.get("authorization")?.replace(/^token /, "") ?? "";
		let status = entitled.get(token) ?? 200;
		return status === 200
			? Response.json({ token: "tid=exchanged;exp=1", expires_at: 1 })
			: Response.json({ message: "Resource not accessible" }, { status });
	});
	let credentials = new AiCredentials({
		storage,
		key: config.encryptionKey,
		origin: ORIGIN,
		clock,
		githubToken: githubSignIn(auth),
		copilotEntitlement: copilotEntitlement({ api: githubApi.url }),
	});
	let router = new Router();
	registerAiRoutes(router, auth, {
		credentials,
		proxy: aiProxy({
			credentials,
			upstreams: {
				openai: upstreams.openai.url,
				anthropic: upstreams.anthropic.url,
				"github-copilot": upstreams.copilot.url,
				catalog: catalog.url,
			},
			clock: () => now.getTime(),
		}),
	});
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: "U_mona",
		now,
	});
	let api = (path: string, cookie: string, init: RequestInit = {}) =>
		router.handle(
			new Request(`${ORIGIN}${path}`, {
				...init,
				headers: { cookie, origin: ORIGIN, ...init.headers },
			}),
		) as Promise<Response>;
	let connect = (cookie: string, provider: string, body: unknown) =>
		api(`/api/ai/credentials/${provider}`, cookie, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	let call = (grant: AiProviderGrant, path: string, init: RequestInit = {}) =>
		router.handle(new Request(`${grant.baseUrl}${path}`, init)) as Promise<Response>;
	return {
		storage,
		entitled,
		githubApi,
		router,
		credentials,
		machines,
		upstreams,
		catalog,
		channel,
		mona,
		hubot,
		api,
		connect,
		call,
		advance(ms: number) {
			now = new Date(now.getTime() + ms);
		},
		now: () => now,
	};
}

function byProvider(grants: AiProviderGrant[]) {
	return Object.fromEntries(grants.map(grant => [grant.provider, grant]));
}

describe("connecting AI credentials", () => {
	it("keeps a key encrypted and only ever says which providers are connected", async () => {
		let world = await setup();
		expect(
			(await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY }))
				.status,
		).toBe(200);
		expect(
			(await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" })).status,
		).toBe(200);

		let listed = await world.api("/api/ai/credentials", world.mona);
		let text = await listed.text();
		expect(text).not.toContain(OPENAI_KEY);
		expect(JSON.parse(text)).toEqual({
			credentials: [
				{
					provider: "github-copilot",
					kind: "github-sign-in",
					updatedAt: world.now().toISOString(),
					copilotAccess: "access",
				},
				{ provider: "openai", kind: "api-key", updatedAt: world.now().toISOString() },
			],
		});
		let stored = await world.storage.aiCredentials.get("U_mona", "openai");
		expect(Buffer.from(stored!.ciphertext!).toString("latin1")).not.toContain(OPENAI_KEY);
		expect(await (await world.api("/api/ai/credentials", world.hubot)).json()).toEqual({
			credentials: [],
		});

		expect((await world.api("/api/ai/credentials/openai", world.mona, { method: "DELETE" })).status)
			.toBe(204);
		expect((await world.api("/api/ai/credentials/openai", world.mona, { method: "DELETE" })).status)
			.toBe(404);
	});

	it("refuses a stranger, another origin, a malformed key and a sign-in Copilot alone takes", async () => {
		let world = await setup();
		let body = JSON.stringify({ kind: "api-key", secret: OPENAI_KEY });
		let put = (cookie: string, headers: Record<string, string> = {}) =>
			world.api("/api/ai/credentials/openai", cookie, { method: "PUT", body, headers });
		expect((await put("")).status).toBe(401);
		expect((await put(world.mona, { origin: "https://elsewhere.test" })).status).toBe(403);
		expect(
			(await world.connect(world.mona, "gemini", { kind: "api-key", secret: OPENAI_KEY }))
				.status,
		).toBe(404);
		expect(
			(await world.connect(world.mona, "openai", { kind: "api-key", secret: "has spaces in" }))
				.status,
		).toBe(422);
		expect((await world.connect(world.mona, "openai", { kind: "github-sign-in" })).status).toBe(
			422,
		);
		expect((await world.connect(world.mona, "openai", { kind: "password" })).status).toBe(400);
		expect(await world.storage.aiCredentials.list("U_mona")).toEqual([]);
	});
});

describe("GitHub Copilot access through a GitHub sign-in", () => {
	let access = async (world: Awaited<ReturnType<typeof setup>>) =>
		((await (await world.api("/api/ai/credentials", world.mona)).json()) as {
			credentials: Array<{ copilotAccess?: string }>;
		}).credentials[0]!.copilotAccess;

	it("says a sign-in GitHub refuses a Copilot token has no access, and checks again when asked", async () => {
		let world = await setup();
		world.entitled.set("ghu_mona_signed_in", 404);
		let connected = await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		expect(connected.status).toBe(200);
		expect(await connected.json()).toMatchObject({ copilotAccess: "none" });
		expect(world.githubApi.seen[0]).toMatchObject({ path: "/copilot_internal/v2/token" });
		expect(world.githubApi.seen[0]!.headers.authorization).toBe("token ghu_mona_signed_in");

		world.entitled.set("ghu_mona_signed_in", 200);
		expect(await access(world)).toBe("none");
		let checked = await world.api("/api/ai/credentials/github-copilot/check", world.mona, {
			method: "POST",
		});
		expect(await checked.json()).toMatchObject({ copilotAccess: "access" });
		expect(await access(world)).toBe("access");

		world.entitled.set("ghu_mona_signed_in", 502);
		world.advance(5 * 60_000);
		expect(await access(world)).toBe("unknown");
		expect(
			(await world.api("/api/ai/credentials/github-copilot/check", world.hubot, {
				method: "POST",
			})).status,
		).toBe(404);
	});

	it("gives a launch no Copilot placeholder without access, and an API key alone is enough", async () => {
		let world = await setup();
		world.entitled.set("ghu_mona_signed_in", 403);
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let launch = () =>
			world.credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
		expect((await launch()).grants).toEqual([]);
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(0);

		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		expect((await launch()).grants.map(grant => grant.provider)).toEqual(["openai"]);
	});

	it("drops Copilot from later launches, and refuses earlier ones, once access is lost", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let launch = () =>
			world.credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 86_400_000),
			});
		let before = (await launch()).grants[0]!;
		expect(before.provider).toBe("github-copilot");
		let models = () =>
			world.call(before, "/models", {
				headers: { authorization: `Bearer ${before.placeholder}` },
			});
		expect((await models()).status).toBe(200);

		world.entitled.set("ghu_mona_signed_in", 401);
		world.advance(5 * 60_000);
		expect((await launch()).grants).toEqual([]);
		let refused = await models();
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
			"no-copilot-access",
		);
		expect(world.upstreams.copilot.seen).toHaveLength(1);
	});
});

describe("the AI credential proxy", () => {
	it("hands a launch one placeholder and base URL per provider its person connected", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let { grants } = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(grants.map(grant => [grant.provider, grant.baseUrl, grant.keyVariable])).toEqual([
			["openai", `${ORIGIN}/api/v1/ai/openai/v1`, AI_KEY_VARIABLES.openai],
			["anthropic", `${ORIGIN}/api/v1/ai/anthropic`, AI_KEY_VARIABLES.anthropic],
		]);
		for (let grant of grants) expect(grant.placeholder).toMatch(/^chopin_ai_[A-Za-z0-9_-]{43}$/);
		let again = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(again.grants[0]!.placeholder).not.toBe(grants[0]!.placeholder);
		expect((await world.credentials.launch({ userId: "U_hubot", expiresAt: world.now() })).grants)
			.toEqual([]);
	});

	it("swaps the placeholder for the real key in its provider's header and forwards the rest unchanged", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let { grants } = await world.credentials.launch({
			userId: "U_mona",
			channelId: world.channel.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		let { openai, anthropic } = byProvider(grants);

		let body = JSON.stringify({ model: "gpt", input: `my key is ${openai!.placeholder}` });
		let answered = await world.call(openai!, `/responses?echo=${openai!.placeholder}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${openai!.placeholder}`,
				"content-type": "application/json",
				"x-trace": openai!.placeholder,
				cookie: "chopin_session=secret",
			},
			body,
		});
		expect(answered.status).toBe(200);
		expect(await answered.json()).toEqual({ ok: true });
		expect(answered.headers.get("set-cookie")).toBeNull();
		let [seen] = world.upstreams.openai.seen;
		expect(seen).toMatchObject({
			method: "POST",
			path: `/v1/responses?echo=${openai!.placeholder}`,
			body,
		});
		expect(seen!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
		expect(seen!.headers["x-trace"]).toBe(openai!.placeholder);
		expect(seen!.headers.cookie).toBeUndefined();

		let messages = await world.call(anthropic!, "/v1/messages", {
			method: "POST",
			headers: { "x-api-key": anthropic!.placeholder, "anthropic-version": "2023-06-01" },
			body: "{}",
		});
		expect(messages.status).toBe(200);
		let [sent] = world.upstreams.anthropic.seen;
		expect(sent!.path).toBe("/v1/messages");
		expect(sent!.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
		expect(sent!.headers.authorization).toBeUndefined();
		expect(sent!.headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("refuses a placeholder that is not in Authorization or x-api-key, or not a live launch's", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let launched = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		let openai = launched.grants[0]!;
		let refused = async (path: string, headers: Record<string, string>) => {
			let response = await world.call(openai, path, { headers });
			expect(response.status).toBe(401);
			return ((await response.json()) as { error: { code: string } }).error.code;
		};
		expect(await refused(`/models?key=${openai.placeholder}`, {})).toBe("no-placeholder");
		expect(await refused("/models", { "x-goog-api-key": openai.placeholder })).toBe(
			"no-placeholder",
		);
		expect(await refused("/models", { authorization: `Bearer ${OPENAI_KEY}` })).toBe(
			"unknown-placeholder",
		);
		expect(
			await refused("/models", {
				authorization: `Bearer ${openai.placeholder}`,
				"x-api-key": "chopin_ai_" + "x".repeat(43),
			}),
		).toBe("no-placeholder");

		let anthropicRoute = { ...openai, baseUrl: `${ORIGIN}/api/v1/ai/anthropic` };
		let wrong = await world.call(anthropicRoute, "/v1/models", {
			headers: { "x-api-key": openai.placeholder },
		});
		expect(wrong.status).toBe(401);
		expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("other-provider");
		expect(world.upstreams.anthropic.seen).toEqual([]);

		await world.credentials.end(launched.launchId);
		expect(await refused("/models", { authorization: `Bearer ${openai.placeholder}` })).toBe(
			"unknown-placeholder",
		);

		let expiring = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 1_000),
		})).grants[0]!;
		world.advance(1_000);
		expect(
			(await world.call(expiring, "/models", {
				headers: { authorization: `Bearer ${expiring.placeholder}` },
			})).status,
		).toBe(401);
		expect(world.upstreams.openai.seen).toEqual([]);
	});

	it("sends nothing to another host, whatever the path, and does not follow a redirect", async () => {
		let world = await setup();
		let elsewhere = provider();
		let redirecting = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants[0]!;
		let headers = { authorization: `Bearer ${openai.placeholder}` };
		for (let path of [`//${elsewhere.host}/steal`, `/@${elsewhere.host}/steal`]) {
			expect((await world.call(openai, path, { headers })).status).toBe(200);
		}
		expect(world.upstreams.openai.seen.map(seen => seen.path)).toEqual([
			`/v1//${elsewhere.host}/steal`,
			`/v1/@${elsewhere.host}/steal`,
		]);

		let bouncing = provider(() =>
			new Response(null, { status: 307, headers: { location: `${elsewhere.url}/v1/models` } })
		);
		let credentials = redirecting.credentials;
		await redirecting.connect(redirecting.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let proxied = aiProxy({ credentials, upstreams: { openai: bouncing.url } });
		let bounce = (await credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(redirecting.now().getTime() + 3_600_000),
		})).grants[0]!;
		let url = new URL(`${bounce.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, { headers: { authorization: `Bearer ${bounce.placeholder}` } }),
			url,
		);
		expect(answer.status).toBe(307);
		expect(answer.headers.get("location")).toBe(`${elsewhere.url}/v1/models`);
		expect(bouncing.seen).toHaveLength(1);
		expect(elsewhere.seen).toEqual([]);
	});

	it("uses the credential of the person the launch runs for, and stops when they disconnect", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.hubot, "openai", { kind: "api-key", secret: OTHER_OPENAI_KEY });
		let launch = (userId: string) =>
			world.credentials.launch({
				userId,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			}).then(launched => launched.grants[0]!);
		let mona = await launch("U_mona");
		let hubot = await launch("U_hubot");
		let models = (grant: AiProviderGrant) =>
			world.call(grant, "/models", { headers: { authorization: `Bearer ${grant.placeholder}` } });
		await models(mona);
		await models(hubot);
		expect(world.upstreams.openai.seen.map(seen => seen.headers.authorization)).toEqual([
			`Bearer ${OPENAI_KEY}`,
			`Bearer ${OTHER_OPENAI_KEY}`,
		]);

		await world.api("/api/ai/credentials/openai", world.mona, { method: "DELETE" });
		let refused = await models(mona);
		expect(refused.status).toBe(403);
		expect(world.upstreams.openai.seen).toHaveLength(2);
	});

	it("ends a launch on a revoked machine or an archived document", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine"),
		});
		let launch = (input: { machineId?: string; channelId?: string }) =>
			world.credentials.launch({
				userId: "U_mona",
				...input,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			}).then(launched => launched.grants[0]!);
		let onMachine = await launch({ machineId: machine.id });
		let onDocument = await launch({ channelId: world.channel.id });
		let status = async (grant: AiProviderGrant) =>
			(await world.call(grant, "/models", {
				headers: { authorization: `Bearer ${grant.placeholder}` },
			})).status;
		expect(await status(onMachine)).toBe(200);
		expect(await status(onDocument)).toBe(200);

		await world.storage.machines.revoke(machine.id, "U_mona", world.now());
		await world.storage.channels.archive({ id: world.channel.id, now: world.now() });
		expect(await status(onMachine)).toBe(401);
		expect(await status(onDocument)).toBe(401);
		expect(world.upstreams.openai.seen).toHaveLength(2);
	});

	it("sends GitHub Copilot the person's GitHub token, renewed by Chopin, and its model list through", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		await world.connect(world.hubot, "github-copilot", {
			kind: "api-key",
			secret: "github_pat_hubot_0123456789",
		});
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine", 3_600),
		});
		let launch = (userId: string, machineId?: string) =>
			world.credentials.launch({
				userId,
				...(machineId ? { machineId } : {}),
				expiresAt: new Date(world.now().getTime() + 86_400_000),
			}).then(launched => launched.grants[0]!);
		let browser = await launch("U_mona");
		let own = await launch("U_mona", machine.id);
		let teammate = await launch("U_hubot", machine.id);
		let models = (grant: AiProviderGrant) =>
			world.call(grant, "/models", {
				headers: { authorization: `Bearer ${grant.placeholder}`, "copilot-integration-id": "x" },
			});

		for (let grant of [browser, own, teammate]) expect((await models(grant)).status).toBe(200);
		world.advance(9 * 3_600_000);
		expect((await models(browser)).status).toBe(200);
		expect((await models(own)).status).toBe(200);

		let seen = world.upstreams.copilot.seen;
		expect(seen.map(request => request.path)).toEqual(Array(5).fill("/models"));
		expect(seen.map(request => request.headers.authorization)).toEqual([
			"Bearer ghu_mona_signed_in",
			"Bearer ghu_machine",
			"Bearer github_pat_hubot_0123456789",
			"Bearer ghu_renewed_1",
			"Bearer ghu_machine_renewed",
		]);
		expect(seen.every(request => request.headers["copilot-integration-id"] === "x")).toBe(true);
	});

	it("refuses GitHub Copilot through a sign-in Chopin no longer holds", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let copilot = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 86_400_000 * 60),
		})).grants[0]!;
		world.advance(31 * 86_400_000);
		let answer = await world.call(copilot, "/models", {
			headers: { authorization: `Bearer ${copilot.placeholder}` },
		});
		expect(answer.status).toBe(403);
		expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
			"sign-in-unavailable",
		);
		expect(world.upstreams.copilot.seen).toEqual([]);
	});

	it("serves the public model catalog without a credential, held for ten minutes", async () => {
		let world = await setup();
		let get = (headers: Record<string, string> = {}) =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json`, { headers }),
			) as Promise<Response>;
		let first = await get();
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ openai: { models: {} } });
		expect((await get({ "if-none-match": '"v1"' })).status).toBe(304);
		expect((await get()).status).toBe(200);
		expect(world.catalog.seen).toHaveLength(1);
		world.advance(10 * 60_000);
		await get();
		expect(world.catalog.seen).toHaveLength(2);
		expect(world.catalog.seen[0]!.headers.authorization).toBeUndefined();
		expect(
			(await world.router.handle(new Request(`${ORIGIN}/api/v1/ai/models.dev/other`)))!.status,
		).toBe(404);
		expect((await world.router.handle(new Request(`${ORIGIN}/api/v1/ai/gemini/v1`)))!.status)
			.toBe(404);
	});
});
