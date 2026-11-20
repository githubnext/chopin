import { afterEach, describe, expect, it } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

import { AI_KEY_VARIABLES, AI_LAUNCH_HEADER } from "@chopin/protocol/ai-credentials";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { abandonable, Requests } from "../handover/requests";
import { Router } from "../http/router";
import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { WriterLease } from "../storage/writer-lease";
import { copilotTokenExchange } from "./copilot";
import { AI_ACCOUNT_UNCHECKED, aiAccountRefusal } from "./account-check";
import { AiCredentialError, AiCredentials } from "./credentials";
import { aiProxy, aiTransport } from "./proxy";
import { githubSignIn, registerAiRoutes } from "./routes";

import type {
	AiCredentialList,
	AiCredentialSummary,
	AiProviderGrant,
} from "@chopin/protocol/ai-credentials";
import type { CopilotToken } from "./copilot";
import type { AiDeadlines, AiLaunch } from "./credentials";
import type { AiTransport } from "./proxy";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant } from "../github/client";
import type { AiCredentialStore, StorageAdapter } from "../storage/port";

const ORIGIN = "https://chopin.test";
const OPENAI_KEY = "sk-real-openai-key-0123456789";
const ANTHROPIC_KEY = "sk-ant-real-anthropic-key-0123456789";
const OTHER_OPENAI_KEY = "sk-someone-elses-openai-key-0123456789";

/** Each placeholder's launch credential, which the launch's runner adds to what its agent sends. */
const LAUNCH_TOKENS = new Map<string, string>();

class RunnerCredentials extends AiCredentials {
	override async launch(input: AiLaunch) {
		let launched = await super.launch(input);
		for (let grant of launched.grants) LAUNCH_TOKENS.set(grant.placeholder, launched.launchToken);
		return launched;
	}
}

/** The header a launch's runner adds for `grant`'s launch. */
function runner(grant: AiProviderGrant): Record<string, string> {
	return { [AI_LAUNCH_HEADER]: LAUNCH_TOKENS.get(grant.placeholder) ?? "" };
}

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
	/** The writer lease this server holds, which every cutoff it writes is written under. */
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
		lease: () => lease,
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
	let refusedKeys = new Set<string>();
	let checkKey = (request: Request) => {
		let key = request.headers.get("x-api-key")
			?? request.headers.get("authorization")?.replace(/^Bearer /, "");
		return refusedKeys.has(key ?? "")
			? Response.json({ error: { message: "Incorrect API key" } }, { status: 401 })
			: Response.json({ data: [] });
	};
	let keyChecks = { openai: provider(checkKey), anthropic: provider(checkKey) };
	let catalog = provider(() =>
		Response.json({ openai: { models: {} } }, { headers: { etag: '"v1"' } })
	);
	let entitled = new Map<string, number>();
	/** The headers GitHub answers a token's refusal with, as a rate limit's are. */
	let refusalHeaders = new Map<string, Record<string, string>>();
	/**
	 * Tokens GitHub won't exchange at all, whatever the account has, as it refuses a token from an app
	 * that isn't one of Copilot's clients: a 403 page that says nothing about the account.
	 */
	let notExchanged = new Set<string>();
	/**
	 * GitHub tokens Copilot's model API takes as they are, as it takes a seat-holder's whichever app
	 * they came from; it refuses any other as Copilot does a token it can't authenticate.
	 */
	let takenRaw = new Set<string>();
	let copilotModels = provider(request => {
		let token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		return takenRaw.has(token)
			? Response.json({ data: [{ id: "gpt-e2e" }] })
			: new Response("unauthorized: token authentication failed", { status: 401 });
	});
	let copilotLifetime = { seconds: 1_800 };
	/** Replies GitHub decides when it is asked but delivers only once released, by token. */
	let heldReplies = new Map<
		string,
		{ asked: PromiseWithResolvers<void>; release: Promise<void> }
	>();
	let githubApi = provider(async request => {
		let token = request.headers.get("authorization")?.replace(/^token /, "") ?? "";
		let status = notExchanged.has(token) ? 403 : entitled.get(token) ?? 200;
		let reply = notExchanged.has(token)
			? new Response("403 Forbidden. For more on scraping GitHub, see the Terms of Service.\n", {
				status,
				headers: { "content-type": "text/plain; charset=utf-8" },
			})
			: status === 200
			? Response.json({
				token: `tid=copilot;for=${token}`,
				expires_at: Math.floor(now.getTime() / 1000) + copilotLifetime.seconds,
			})
			// A 403 is GitHub saying the account has no Copilot subscription; any other status says
			// nothing about it.
			: Response.json(
				status === 403
					? {
						message: "You do not have access to GitHub Copilot.",
						error_details: {
							notification_id: "no_copilot_access",
							message: "No access to GitHub Copilot found.",
							title: "Account unavailable",
							url: "https://github.com/features/copilot",
						},
					}
					: { message: "Resource not accessible" },
				{ status, headers: refusalHeaders.get(token) ?? {} },
			);
		let held = heldReplies.get(token);
		if (held) {
			heldReplies.delete(token);
			held.asked.resolve();
			await held.release;
		}
		return reply;
	});
	let credentials = new RunnerCredentials({
		storage,
		key: config.encryptionKey,
		origin: ORIGIN,
		clock,
		githubToken: githubSignIn(auth),
		copilotToken: copilotTokenExchange({
			api: githubApi.url,
			copilotApi: copilotModels.url,
			clock: () => now.getTime(),
		}),
		upstreams: { openai: keyChecks.openai.url, anthropic: keyChecks.anthropic.url },
		lease: () => lease,
	});
	let router = new Router();
	/** What happens to the clock as the transport takes a send, before it reads it. */
	let entering: (() => void) | undefined;
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
			clock: () => {
				entering?.();
				return now.getTime();
			},
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
	let call = (grant: AiProviderGrant, path: string, init: RequestInit = {}) => {
		let headers = new Headers(init.headers);
		if (!headers.has(AI_LAUNCH_HEADER)) {
			headers.set(AI_LAUNCH_HEADER, runner(grant)[AI_LAUNCH_HEADER]!);
		}
		return router.handle(
			new Request(`${grant.baseUrl}${path}`, { ...init, headers }),
		) as Promise<Response>;
	};
	return {
		storage,
		lease,
		sessions,
		entitled,
		refusalHeaders,
		notExchanged,
		takenRaw,
		copilotModels,
		copilotLifetime,
		githubApi,
		router,
		credentials,
		machines,
		upstreams,
		refusedKeys,
		keyChecks,
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
		/** Runs `change` each time the transport takes a send, before it reads the clock. */
		onTransport(change: () => void) {
			entering = change;
		},
		/**
		 * Holds GitHub's next reply to `token`: decided as it is asked, delivered once released.
		 * Resolves `asked` once GitHub has decided it.
		 */
		holdReply(token: string) {
			let asked = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			heldReplies.set(token, { asked, release: release.promise });
			return { asked: asked.promise, release: () => release.resolve() };
		},
		now: () => now,
	};
}

function byProvider(grants: AiProviderGrant[]) {
	return Object.fromEntries(grants.map(grant => [grant.provider, grant]));
}

function isOpenai(grant: AiProviderGrant) {
	return grant.provider === "openai";
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
				{
					provider: "openai",
					kind: "api-key",
					updatedAt: world.now().toISOString(),
					suffix: "6789",
				},
			],
		});
		let stored = await world.storage.aiCredentials.get("U_mona", "openai");
		expect(Buffer.from(stored!.ciphertext!).toString("latin1")).not.toContain(OPENAI_KEY);
		expect(await (await world.api("/api/ai/credentials", world.hubot)).json()).toEqual({
			credentials: [{
				provider: "github-copilot",
				kind: "github-sign-in",
				copilotAccess: "access",
			}],
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

	it("checks a key with its provider before saving it, and keeps the working key when a replacement is refused", async () => {
		let world = await setup();
		let cases = [
			["openai", "OpenAI", OPENAI_KEY, "sk-refused-openai-key-0123456789", "authorization"],
			["anthropic", "Anthropic", ANTHROPIC_KEY, "sk-ant-refused-key-0123456789", "x-api-key"],
		] as const;
		for (let [provider, name, working, refused, header] of cases) {
			world.refusedKeys.add(refused);
			let checks = world.keyChecks[provider].seen;
			let connect = (secret: string) =>
				world.connect(world.mona, provider, { kind: "api-key", secret });

			let added = await connect(refused);
			expect(added.status).toBe(422);
			expect(await added.json()).toEqual({
				error: `${name} refused this key. Check it and try again.`,
			});
			expect(await world.storage.aiCredentials.get("U_mona", provider)).toBeUndefined();
			expect(checks).toHaveLength(1);

			expect((await connect(working)).status).toBe(200);
			expect(checks).toHaveLength(2);
			let saved = await world.storage.aiCredentials.get("U_mona", provider);

			let replaced = await connect(refused);
			expect(replaced.status).toBe(422);
			expect(await replaced.text()).not.toContain(refused);
			expect(await world.storage.aiCredentials.get("U_mona", provider)).toEqual(saved);
			expect(checks.map(seen => [seen.method, seen.path, seen.headers[header]])).toEqual(
				[refused, working, refused].map(key => [
					"GET",
					"/v1/models",
					header === "authorization" ? `Bearer ${key}` : key,
				]),
			);
		}
		expect(world.keyChecks.anthropic.seen.every(seen => seen.headers["anthropic-version"])).toBe(
			true,
		);

		let { openai, anthropic } = byProvider((await launch(world)).grants);
		let responses = await world.call(openai!, "/responses", {
			method: "POST",
			headers: { authorization: `Bearer ${openai!.placeholder}` },
			body: "{}",
		});
		let messages = await world.call(anthropic!, "/v1/messages", {
			method: "POST",
			headers: { "x-api-key": anthropic!.placeholder },
			body: "{}",
		});
		expect([responses.status, messages.status]).toEqual([200, 200]);
		expect(world.upstreams.openai.seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
		expect(world.upstreams.anthropic.seen[0]!.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
	});

	it("shows a key's last characters and when a launch last sent it, apart from when it was saved", async () => {
		let world = await setup();
		let openaiSummary = async () => {
			let text = await (await world.api("/api/ai/credentials", world.mona)).text();
			expect(text).not.toContain(OPENAI_KEY);
			return (JSON.parse(text) as AiCredentialList).credentials
				.find(summary => summary.provider === "openai");
		};
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let savedAt = world.now().toISOString();
		expect(await openaiSummary()).toEqual({
			provider: "openai",
			kind: "api-key",
			updatedAt: savedAt,
			suffix: "6789",
		});

		world.advance(60_000);
		let openai = (await launch(world)).grants.find(isOpenai)!;
		let answered = await world.call(openai, "/models", {
			headers: { authorization: `Bearer ${openai.placeholder}` },
		});
		expect(answered.status).toBe(200);
		let usedAt = world.now().toISOString();
		world.advance(1_000);
		expect(await openaiSummary()).toEqual({
			provider: "openai",
			kind: "api-key",
			updatedAt: savedAt,
			suffix: "6789",
			lastUsedAt: usedAt,
		});

		await world.connect(world.mona, "openai", {
			kind: "api-key",
			secret: "sk-replacement-openai-key-4321",
		});
		expect(await openaiSummary()).toEqual({
			provider: "openai",
			kind: "api-key",
			updatedAt: world.now().toISOString(),
			suffix: "4321",
		});
	});

	it("shows the last use in the minute it was made, and never an earlier one", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await launch(world)).grants.find(isOpenai)!;
		let lastUsed = async () =>
			(await world.storage.aiCredentials.get("U_mona", "openai"))!.lastUsedAt?.toISOString();
		let useAt = async (time: string) => {
			world.advance(new Date(time).getTime() - world.now().getTime());
			let answered = await world.call(openai, "/models", {
				headers: { authorization: `Bearer ${openai.placeholder}` },
			});
			expect(answered.status).toBe(200);
			return lastUsed();
		};
		expect(await useAt("2026-10-09T12:00:59.000Z")).toBe("2026-10-09T12:00:59.000Z");
		expect(await useAt("2026-10-09T12:01:01.000Z")).toBe("2026-10-09T12:01:01.000Z");
		expect(await useAt("2026-10-09T12:01:59.999Z")).toBe("2026-10-09T12:01:01.000Z");
		expect(await useAt("2026-10-09T12:02:00.000Z")).toBe("2026-10-09T12:02:00.000Z");

		let credential = (await world.storage.aiCredentials.get("U_mona", "openai"))!;
		await world.storage.aiCredentials.used(credential, new Date("2026-10-09T12:05:30.000Z"));
		expect(await useAt("2026-10-09T12:04:00.000Z")).toBe("2026-10-09T12:05:30.000Z");
	});

	it("shows the minute a request was sent in when the clock reaches the next minute as the transport takes it", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await launch(world)).grants.find(isOpenai)!;
		world.advance(new Date("2026-10-09T12:00:59.999Z").getTime() - world.now().getTime());
		world.onTransport(() => world.advance(1));
		let answered = await world.call(openai, "/models", {
			headers: { authorization: `Bearer ${openai.placeholder}` },
		});
		expect(answered.status).toBe(200);
		expect(world.now().toISOString()).toBe("2026-10-09T12:01:00.000Z");
		expect((await world.storage.aiCredentials.get("U_mona", "openai"))!.lastUsedAt)
			.toEqual(new Date("2026-10-09T12:01:00.000Z"));
	});

	it("says a key it can no longer read is unusable until it is connected again", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let saved = (await world.storage.aiCredentials.get("U_mona", "openai"))!;
		await world.storage.aiCredentials.put(world.lease, {
			...saved,
			ciphertext: new Uint8Array(saved.ciphertext!.length).fill(7),
		});
		let listed = async () =>
			((await (await world.api("/api/ai/credentials", world.mona)).json()) as AiCredentialList)
				.credentials;
		let unusable = async () =>
			(await listed()).filter(credential => credential.unusable).map(({ provider }) => provider);
		expect(await unusable()).toEqual(["openai"]);

		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		expect(await unusable()).toEqual([]);
	});
});

describe("GitHub Copilot access through a GitHub sign-in", () => {
	let access = async (world: Awaited<ReturnType<typeof setup>>) =>
		((await (await world.api("/api/ai/credentials", world.mona)).json()) as {
			credentials: Array<{ copilotAccess?: string }>;
		}).credentials[0]!.copilotAccess;

	it("uses a signed-in person's Copilot with nothing saved, and withholds only Copilot when GitHub refuses it", async () => {
		let world = await setup();
		expect(await (await world.api("/api/ai/credentials", world.mona)).json()).toEqual({
			credentials: [{
				provider: "github-copilot",
				kind: "github-sign-in",
				copilotAccess: "access",
			}],
		});
		let launched = await launch(world);
		expect(launched).toMatchObject({ grants: [{ provider: "github-copilot" }], withheld: [] });
		let copilot = launched.grants[0]!;
		let models = await world.call(copilot, "/models", {
			headers: { authorization: `Bearer ${copilot.placeholder}` },
		});
		expect(models.status).toBe(200);
		expect(world.upstreams.copilot.seen.map(seen => seen.headers.authorization)).toEqual([
			"Bearer tid=copilot;for=ghu_mona_signed_in",
		]);
		expect(await world.storage.aiCredentials.list("U_mona")).toEqual([]);

		world.entitled.set("ghu_hubot", 403);
		await world.connect(world.hubot, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let checked = await world.api("/api/ai/credentials/github-copilot/check", world.hubot, {
			method: "POST",
		});
		expect(await checked.json()).toEqual({
			provider: "github-copilot",
			kind: "github-sign-in",
			copilotAccess: "none",
		});
		let hubot = await world.credentials.launch({
			userId: "U_hubot",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(hubot.grants.map(grant => grant.provider)).toEqual(["anthropic"]);
		expect(hubot.withheld).toEqual([{ provider: "github-copilot", reason: "no-copilot-access" }]);
	});

	it("says a sign-in GitHub says has no Copilot subscription has no access, and checks again when asked", async () => {
		let world = await setup();
		world.entitled.set("ghu_mona_signed_in", 403);
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
		let hubot = await world.api("/api/ai/credentials/github-copilot/check", world.hubot, {
			method: "POST",
		});
		expect(await hubot.json()).toMatchObject({ copilotAccess: "access" });
	});

	it("never says a sign-in neither GitHub nor Copilot takes has no access: its check couldn't be done, nothing of it is kept, and a seat shows at once", async () => {
		let world = await setup();
		let checked = async () =>
			((await (await world.api("/api/ai/credentials/github-copilot/check", world.mona, {
				method: "POST",
			})).json()) as AiCredentialSummary).copilotAccess;
		// Mona has a seat, but GitHub won't exchange her sign-in's token for a Copilot token.
		world.notExchanged.add("ghu_mona_signed_in");
		expect(await checked()).toBe("unknown");
		expect(await access(world)).toBe("unknown");
		expect(await launch(world)).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "copilot-unavailable" }],
		});
		expect(await aiAccountRefusal(world.credentials, "U_mona")).toEqual({
			message: AI_ACCOUNT_UNCHECKED,
			code: "no-ai-account",
		});
		world.notExchanged.delete("ghu_mona_signed_in");
		for (let status of [401, 404]) {
			world.entitled.set("ghu_mona_signed_in", status);
			expect(await checked()).toBe("unknown");
			expect(await access(world)).toBe("unknown");
		}

		world.entitled.delete("ghu_mona_signed_in");
		expect(await access(world)).toBe("access");
		expect((await launch(world)).grants.map(grant => grant.provider)).toEqual(["github-copilot"]);
	});

	it("reaches Copilot through a sign-in GitHub won't exchange, sending its GitHub token to Copilot's model API alone, as Copilot's CLI does", async () => {
		let world = await setup();
		// GitHub refuses a GitHub App's user token a Copilot token, a seat-holder's too.
		world.notExchanged.add("ghu_mona_signed_in");
		world.takenRaw.add("ghu_mona_signed_in");
		expect(await access(world)).toBe("access");
		expect(world.copilotModels.seen).toHaveLength(1);
		expect(world.copilotModels.seen[0]).toMatchObject({ method: "GET", path: "/models" });
		expect(world.copilotModels.seen[0]!.headers).toMatchObject({
			authorization: "Bearer ghu_mona_signed_in",
			"copilot-integration-id": "copilot-developer-cli",
		});

		let launched = await launch(world);
		expect(launched.withheld).toEqual([]);
		let copilot = launched.grants[0]!;
		expect(copilot.provider).toBe("github-copilot");
		let models = await world.call(copilot, "/models", {
			headers: {
				authorization: `Bearer ${copilot.placeholder}`,
				"copilot-integration-id": "vscode-chat",
			},
		});
		expect(models.status).toBe(200);
		expect(world.upstreams.copilot.seen).toHaveLength(1);
		expect(world.upstreams.copilot.seen[0]!.headers).toMatchObject({
			authorization: "Bearer ghu_mona_signed_in",
			"copilot-integration-id": "copilot-developer-cli",
		});

		// A seat GitHub says is gone withholds Copilot again, whatever Copilot took before.
		world.notExchanged.delete("ghu_mona_signed_in");
		world.entitled.set("ghu_mona_signed_in", 403);
		world.advance(5 * 60_000);
		expect(await launch(world)).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "no-copilot-access" }],
		});
	});

	it("shows every session of a person the Copilot access GitHub last confirmed for their sign-in, lost and back again", async () => {
		let world = await setup();
		let second = (await world.sessions.issue("U_mona", grant("ghu_mona_second"))).cookie.split(
			";",
		)[0]!;
		let listed = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials", cookie)).json()) as AiCredentialList)
				.credentials[0]!.copilotAccess;
		let checked = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials/github-copilot/check", cookie, {
				method: "POST",
			})).json()) as AiCredentialSummary).copilotAccess;
		let seat = (status?: number) => {
			for (let token of ["ghu_mona_signed_in", "ghu_mona_second"]) {
				if (status) world.entitled.set(token, status);
				else world.entitled.delete(token);
			}
		};
		expect(await listed(world.mona)).toBe("access");
		expect(await listed(second)).toBe("access");

		seat(403);
		expect(await checked(second)).toBe("none");
		expect(await listed(world.mona)).toBe("none");
		expect(await listed(second)).toBe("none");

		seat();
		expect(await checked(world.mona)).toBe("access");
		expect(await listed(world.mona)).toBe("access");
		expect(await listed(second)).toBe("access");
	});

	it("shows no access once a seat GitHub found earlier reaches Chopin after another session's refusal, and access once it is back", async () => {
		let world = await setup();
		let second = (await world.sessions.issue("U_mona", grant("ghu_mona_second"))).cookie.split(
			";",
		)[0]!;
		let listed = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials", cookie)).json()) as AiCredentialList)
				.credentials[0]!.copilotAccess;
		let checked = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials/github-copilot/check", cookie, {
				method: "POST",
			})).json()) as AiCredentialSummary).copilotAccess;
		let seat = (status?: number) => {
			for (let token of ["ghu_mona_signed_in", "ghu_mona_second"]) {
				if (status) world.entitled.set(token, status);
				else world.entitled.delete(token);
			}
		};

		let held = world.holdReply("ghu_mona_signed_in");
		let first = listed(world.mona);
		await held.asked;
		seat(403);
		expect(await listed(second)).toBe("none");
		held.release();
		expect(await first).toBe("none");
		expect(await listed(world.mona)).toBe("none");
		expect(await listed(second)).toBe("none");

		seat();
		expect(await checked(world.mona)).toBe("access");
		expect(await listed(world.mona)).toBe("access");
		expect(await listed(second)).toBe("access");
	});

	it("says GitHub throttling a Copilot check is unknown and loses no seat, apart from a refusal and a seat", async () => {
		let world = await setup();
		let second = (await world.sessions.issue("U_mona", grant("ghu_mona_second"))).cookie.split(
			";",
		)[0]!;
		let listed = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials", cookie)).json()) as AiCredentialList)
				.credentials[0]!.copilotAccess;
		let checked = async (cookie: string) =>
			((await (await world.api("/api/ai/credentials/github-copilot/check", cookie, {
				method: "POST",
			})).json()) as AiCredentialSummary).copilotAccess;
		expect(await listed(world.mona)).toBe("access");

		let throttled: Array<[number, Record<string, string>]> = [
			[403, { "retry-after": "60" }],
			[403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760011260" }],
			[429, {}],
		];
		for (let [status, headers] of throttled) {
			world.entitled.set("ghu_mona_second", status);
			world.refusalHeaders.set("ghu_mona_second", headers);
			expect(await checked(second)).toBe("unknown");
			expect(await listed(world.mona)).toBe("access");
		}

		world.refusalHeaders.delete("ghu_mona_second");
		for (let token of ["ghu_mona_signed_in", "ghu_mona_second"]) world.entitled.set(token, 403);
		expect(await checked(second)).toBe("none");
		expect(await listed(world.mona)).toBe("none");

		for (let token of ["ghu_mona_signed_in", "ghu_mona_second"]) world.entitled.delete(token);
		expect(await checked(second)).toBe("access");
	});

	it("settles neither of two crossing answers about a token while GitHub can't be asked again, and settles that account alone once it answers", async () => {
		let world = await setup();
		let exchanges = (token: string) =>
			world.githubApi.seen.filter(seen => seen.headers.authorization === `token ${token}`).length;
		world.entitled.set("ghu_hubot", 403);
		let hubot = await world.api("/api/ai/credentials/github-copilot/check", world.hubot, {
			method: "POST",
		});
		expect(await hubot.json()).toMatchObject({ copilotAccess: "none" });

		// A check of what Mona may use is asked while she has a seat, and its answer is held back.
		let held = world.holdReply("ghu_mona_signed_in");
		let pending = world.credentials.available("U_mona");
		await held.asked;
		// The AI accounts page opens and GitHub finds no seat for the same token.
		world.entitled.set("ghu_mona_signed_in", 403);
		let checked = await world.api("/api/ai/credentials/github-copilot/check", world.mona, {
			method: "POST",
		});
		expect(await checked.json()).toMatchObject({ copilotAccess: "none" });
		// The seat then arrives, after the refusal; asked again, GitHub can't answer.
		world.entitled.set("ghu_mona_signed_in", 503);
		held.release();
		expect(await pending).toEqual({
			providers: [],
			withheld: [{ provider: "github-copilot", reason: "copilot-unavailable" }],
		});
		expect(await access(world)).toBe("unknown");
		expect(await aiAccountRefusal(world.credentials, "U_mona")).toEqual({
			message: AI_ACCOUNT_UNCHECKED,
			code: "no-ai-account",
		});
		expect(
			((await (await world.api("/api/ai/credentials", world.hubot)).json()) as AiCredentialList)
				.credentials[0]!.copilotAccess,
		).toBe("none");
		expect(exchanges("ghu_hubot")).toBe(1);

		world.entitled.delete("ghu_mona_signed_in");
		expect(await access(world)).toBe("access");
		let asked = exchanges("ghu_mona_signed_in");
		expect(await access(world)).toBe("access");
		expect(exchanges("ghu_mona_signed_in")).toBe(asked);
	});

	it("never answers a sign-in with what GitHub said of the same token connected instead, and shows it the seat a launch on its machine confirmed", async () => {
		let world = await setup();
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine", 3_600),
		});
		// Mona connects her sign-in's own token while her account has no seat, then removes it.
		for (let token of ["ghu_mona_signed_in", "ghu_machine"]) world.entitled.set(token, 403);
		let pasted = await world.connect(world.mona, "github-copilot", {
			kind: "api-key",
			secret: "ghu_mona_signed_in",
		});
		expect(await pasted.json()).toMatchObject({ kind: "api-key", copilotAccess: "none" });
		let removed = await world.api("/api/ai/credentials/github-copilot", world.mona, {
			method: "DELETE",
		});
		expect(removed.status).toBe(204);

		// Her seat arrives, and a launch on her machine gets Copilot through its own token.
		for (let token of ["ghu_mona_signed_in", "ghu_machine"]) world.entitled.delete(token);
		let onMachine = await world.credentials.launch({
			userId: "U_mona",
			machineId: machine.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(onMachine.grants.map(grant => grant.provider)).toEqual(["github-copilot"]);
		expect(await access(world)).toBe("access");
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
		expect(await launch()).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "no-copilot-access" }],
		});
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

		world.entitled.set("ghu_mona_signed_in", 403);
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
			[
				"github-copilot",
				`${ORIGIN}/api/v1/ai/github-copilot`,
				AI_KEY_VARIABLES["github-copilot"],
			],
			["openai", `${ORIGIN}/api/v1/ai/openai/v1`, AI_KEY_VARIABLES.openai],
			["anthropic", `${ORIGIN}/api/v1/ai/anthropic`, AI_KEY_VARIABLES.anthropic],
		]);
		for (let grant of grants) expect(grant.placeholder).toMatch(/^chopin_ai_[A-Za-z0-9_-]{43}$/);
		let again = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(again.grants[0]!.placeholder).not.toBe(grants[0]!.placeholder);
		let hubot = await world.credentials.launch({
			userId: "U_hubot",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		expect(hubot.grants.map(grant => grant.provider)).toEqual(["github-copilot"]);
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

	it("refuses a request that also carries its placeholder in a header it doesn't forward, rather than send it changed", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await launch(world)).grants.find(isOpenai)!;
		let responses = (headers: Record<string, string>) =>
			world.call(openai, "/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${openai.placeholder}`, ...headers },
				body: "{}",
			});
		for (
			let [name, value] of [
				["referer", `https://agent.test/?key=${openai.placeholder}`],
				["cookie", `key=${openai.placeholder}`],
				["x-forwarded-for", openai.placeholder],
				["forwarded", `for="${openai.placeholder}"`],
				["proxy-authorization", `Bearer ${openai.placeholder}`],
			]
		) {
			let refused = await responses({ [name!]: value! });
			expect(refused.status).toBe(400);
			expect(await code(refused)).toBe("dropped-header");
		}
		expect(world.upstreams.openai.seen).toEqual([]);

		let sent = await responses({ "x-trace": openai.placeholder, referer: "https://agent.test/" });
		expect(sent.status).toBe(200);
		let [seen] = world.upstreams.openai.seen;
		expect(seen!.headers["x-trace"]).toBe(openai.placeholder);
		expect(seen!.headers.referer).toBeUndefined();
		expect(seen!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
	});

	it("refuses a request carrying any launch's stand-in in a header it drops, by its value or its name, and forwards the headers it keeps unchanged", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let { openai, anthropic } = byProvider((await launch(world)).grants);
		let elsewhere = byProvider((await launch(world)).grants).anthropic!;
		let responses = (headers: Record<string, string>) =>
			world.call(openai!, "/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${openai!.placeholder}`, ...headers },
				body: "{}",
			});
		let dropping: Array<Record<string, string>> = [
			{ cookie: `other=${anthropic!.placeholder}` },
			{ referer: `https://agent.test/?key=${elsewhere.placeholder}` },
			{ [`x-forwarded-${openai!.placeholder}`]: "1" },
			{ [`x-forwarded-${anthropic!.placeholder}`]: "1" },
		];
		for (let headers of dropping) {
			let refused = await responses(headers);
			expect(refused.status).toBe(400);
			expect(await code(refused)).toBe("dropped-header");
		}
		expect(world.upstreams.openai.seen).toEqual([]);

		let sent = await responses({
			"x-trace": anthropic!.placeholder,
			"openai-beta": "responses=v1",
			cookie: "theme=dark",
		});
		expect(sent.status).toBe(200);
		let [seen] = world.upstreams.openai.seen;
		expect(seen!.headers["x-trace"]).toBe(anthropic!.placeholder);
		expect(seen!.headers["openai-beta"]).toBe("responses=v1");
		expect(seen!.headers.cookie).toBeUndefined();
	});

	it("refuses a placeholder that is not in Authorization or x-api-key, or not a live launch's", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let launched = await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		let openai = launched.grants.find(isOpenai)!;
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
		})).grants.find(isOpenai)!;
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
		})).grants.find(isOpenai)!;
		let headers = { authorization: `Bearer ${openai.placeholder}` };
		for (let path of [`//${elsewhere.host}/v1/models`, `/models/@${elsewhere.host}`]) {
			let refused = await world.call(openai, path, { headers });
			expect(refused.status).toBe(404);
			expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("route");
		}
		expect(world.upstreams.openai.seen).toEqual([]);

		let bouncing = provider(() =>
			new Response(null, { status: 307, headers: { location: `${elsewhere.url}/v1/models` } })
		);
		let credentials = redirecting.credentials;
		await redirecting.connect(redirecting.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let proxied = aiProxy({ credentials, upstreams: { openai: bouncing.url } });
		let bounce = (await credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(redirecting.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		let url = new URL(`${bounce.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${bounce.placeholder}`, ...runner(bounce) },
			}),
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
			}).then(launched => launched.grants.find(isOpenai)!);
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
			}).then(launched => launched.grants.find(isOpenai)!);
		let onMachine = await launch({ machineId: machine.id });
		let onDocument = await launch({ channelId: world.channel.id });
		let status = async (grant: AiProviderGrant) =>
			(await world.call(grant, "/models", {
				headers: { authorization: `Bearer ${grant.placeholder}` },
			})).status;
		expect(await status(onMachine)).toBe(200);
		expect(await status(onDocument)).toBe(200);

		await world.storage.machines.revoke(world.lease, machine.id, "U_mona", world.now());
		await world.storage.channels.archive({
			id: world.channel.id,
			now: world.now(),
			lease: world.lease,
		});
		expect(await status(onMachine)).toBe(401);
		expect(await status(onDocument)).toBe(401);
		await world.storage.channels.restore({ id: world.channel.id, now: world.now() });
		expect(await status(onDocument)).toBe(401);
		expect(world.upstreams.openai.seen).toHaveLength(2);
	});

	it("ends a launch for the machine that holds its credential, in a process started since, and for no other machine", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let pair = (label: string) =>
			world.machines.pair({
				userId: "U_mona",
				label,
				repositories: [],
				autoRun: false,
				grant: grant(`ghu_${label}`),
			}).then(paired => paired.machine);
		let machine = await pair("studio");
		let other = await pair("laptop");
		let launched = await world.credentials.launch({
			userId: "U_mona",
			machineId: machine.id,
			channelId: world.channel.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		let openai = launched.grants.find(isOpenai)!;
		let status = async () =>
			(await world.call(openai, "/models", {
				headers: { authorization: `Bearer ${openai.placeholder}` },
			})).status;
		expect(await status()).toBe(200);
		let successor = new AiCredentials({
			storage: world.storage,
			key: new Uint8Array(32).fill(9),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => undefined,
			copilotToken: async () => undefined,
			lease: () => world.lease,
		});
		expect(await successor.endHeld(launched.launchToken, other.id)).toBe(false);
		expect(await successor.endHeld("chopin_launch_unknown", machine.id)).toBe(false);
		expect(await status()).toBe(200);
		expect(await successor.endHeld(launched.launchToken, machine.id)).toBe(true);
		expect(await status()).toBe(401);
		expect(await successor.endHeld(launched.launchToken, machine.id)).toBe(false);
	});

	it("sends GitHub Copilot the Copilot token GitHub gives the person's GitHub token, renewed by Chopin", async () => {
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
			"Bearer tid=copilot;for=ghu_mona_signed_in",
			"Bearer tid=copilot;for=ghu_machine",
			"Bearer tid=copilot;for=github_pat_hubot_0123456789",
			"Bearer tid=copilot;for=ghu_renewed_1",
			"Bearer tid=copilot;for=ghu_machine_renewed",
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

	it("serves the public model catalog only to a stand-in with its own live launch's credential, held for ten minutes, and asks for it with no credential", async () => {
		let world = await setup();
		let launched = await launch(world);
		let other = await launch(world);
		let standIn = launched.grants[0]!.placeholder;
		let get = (
			placeholder: string | undefined,
			launchToken: string | undefined,
			headers: Record<string, string> = {},
		) =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json`, {
					headers: {
						...(placeholder ? { authorization: `Bearer ${placeholder}` } : {}),
						...(launchToken ? { [AI_LAUNCH_HEADER]: launchToken } : {}),
						...headers,
					},
				}),
			) as Promise<Response>;
		let refusal = async (response: Response) => [response.status, await code(response)];
		let refusals = async () => [
			await refusal(await get(undefined, launched.launchToken)),
			await refusal(await get(standIn, undefined)),
			await refusal(await get("chopin_ai_" + "x".repeat(43), launched.launchToken)),
			await refusal(await get(other.grants[0]!.placeholder, launched.launchToken)),
			await refusal(
				await get(undefined, launched.launchToken, { "if-none-match": '"v1"' }),
			),
		];
		let refused = [
			[401, "no-placeholder"],
			[401, "no-launch"],
			[401, "unknown-placeholder"],
			[401, "other-launch"],
			[401, "no-placeholder"],
		];
		expect(await refusals()).toEqual(refused);
		expect(world.catalog.seen).toEqual([]);

		let first = await get(standIn, launched.launchToken);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ openai: { models: {} } });
		expect(await refusals()).toEqual(refused);
		expect((await get(standIn, launched.launchToken, { "if-none-match": '"v1"' })).status).toBe(
			304,
		);
		expect(
			(await world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json`, {
					headers: { "x-api-key": standIn, [AI_LAUNCH_HEADER]: launched.launchToken },
				}),
			))!.status,
		).toBe(200);
		expect(world.catalog.seen).toHaveLength(1);
		world.advance(10 * 60_000);
		await get(standIn, launched.launchToken);
		expect(world.catalog.seen).toHaveLength(2);
		for (let seen of world.catalog.seen) {
			expect(seen.headers.authorization).toBeUndefined();
			expect(seen.headers["x-api-key"]).toBeUndefined();
			expect(seen.headers[AI_LAUNCH_HEADER]).toBeUndefined();
		}

		await world.credentials.end(launched.launchId);
		expect(await refusal(await get(standIn, launched.launchToken))).toEqual([
			401,
			"unknown-placeholder",
		]);
		expect(
			await refusal(await get(standIn, launched.launchToken, { "if-none-match": '"v1"' })),
		).toEqual([401, "unknown-placeholder"]);
		world.advance(10 * 60_000);
		expect(await refusal(await get(standIn, launched.launchToken))).toEqual([
			401,
			"unknown-placeholder",
		]);
		expect(world.catalog.seen).toHaveLength(2);

		expect(
			(await world.router.handle(new Request(`${ORIGIN}/api/v1/ai/models.dev/other`)))!.status,
		).toBe(404);
		expect((await world.router.handle(new Request(`${ORIGIN}/api/v1/ai/gemini/v1`)))!.status)
			.toBe(404);
	});

	it("refuses the catalog to a request carrying a stand-in in its query or a header it doesn't send on, and fetches it with no credential", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let launched = await launch(world);
		let { "github-copilot": copilot, openai } = byProvider(launched.grants);
		let get = (search: string, headers: Record<string, string> = {}) =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json${search}`, {
					headers: {
						authorization: `Bearer ${copilot!.placeholder}`,
						[AI_LAUNCH_HEADER]: launched.launchToken,
						...headers,
					},
				}),
			) as Promise<Response>;
		let cases: Array<[search: string, headers: Record<string, string>, refusal: string]> = [
			[`?key=${openai!.placeholder}`, {}, "dropped-query"],
			[`?key=${copilot!.placeholder.replaceAll("_", "%5F")}`, {}, "dropped-query"],
			["", { "x-trace": openai!.placeholder }, "dropped-header"],
			["", { "if-none-match": `"${copilot!.placeholder}"` }, "dropped-header"],
			["", { [`x-${openai!.placeholder}`]: "1" }, "dropped-header"],
		];
		for (let warm of [false, true]) {
			for (let [search, headers, refusal] of cases) {
				let refused = await get(search, headers);
				expect(refused.status).toBe(400);
				expect(await code(refused)).toBe(refusal);
			}
			expect(world.catalog.seen).toHaveLength(warm ? 1 : 0);
			let served = await get("?v=1", { "x-trace": "run-7" });
			expect(served.status).toBe(200);
			expect(await served.json()).toEqual({ openai: { models: {} } });
		}
		let [fetched] = world.catalog.seen;
		expect(fetched!.path).toBe("/api.json");
		for (let header of ["authorization", "x-api-key", AI_LAUNCH_HEADER, "x-trace"]) {
			expect(fetched!.headers[header]).toBeUndefined();
		}
	});

	it("refuses the catalog to a query with a field it can't decode, whichever field holds an escaped stand-in", async () => {
		let world = await setup();
		let launched = await launch(world);
		let copilot = launched.grants[0]!;
		let get = (search: string) =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json${search}`, {
					headers: {
						authorization: `Bearer ${copilot.placeholder}`,
						[AI_LAUNCH_HEADER]: launched.launchToken,
					},
				}),
			) as Promise<Response>;
		let escaped = `key=%63${copilot.placeholder.slice(1)}`;
		let unreadable = "next=%E0%A4%A";
		for (let warm of [false, true]) {
			for (
				let search of [`?${escaped}&${unreadable}`, `?${unreadable}&${escaped}`, `?${unreadable}`]
			) {
				let refused = await get(search);
				expect(refused.status).toBe(400);
				expect(await code(refused)).toBe("unreadable-query");
			}
			expect(world.catalog.seen).toHaveLength(warm ? 1 : 0);
			let served = await get("");
			expect(served.status).toBe(200);
			expect(await served.json()).toEqual({ openai: { models: {} } });
		}
		expect(world.catalog.seen).toHaveLength(1);
	});

	it("refuses the catalog to a launch that ended while it was checked, from a warm copy too", async () => {
		let world = await setup();
		let launched = await world.credentials.launch({
			userId: "U_mona",
			channelId: world.channel.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		});
		let get = () =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/models.dev/api.json`, {
					headers: {
						authorization: `Bearer ${launched.grants[0]!.placeholder}`,
						[AI_LAUNCH_HEADER]: launched.launchToken,
					},
				}),
			) as Promise<Response>;
		expect((await get()).status).toBe(200);
		expect(world.catalog.seen).toHaveLength(1);

		let channels = world.storage.channels;
		let read = channels.get.bind(channels);
		let reading = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		channels.get = async id => {
			channels.get = read;
			let found = await read(id);
			reading.resolve();
			await release.promise;
			return found;
		};
		let pending = get();
		await reading.promise;
		await world.credentials.end(launched.launchId);
		release.resolve();
		let refused = await pending;
		expect(refused.status).toBe(401);
		expect(world.catalog.seen).toHaveLength(1);
	});
});

async function code(response: Response) {
	return ((await response.json()) as { error: { code: string } }).error.code;
}

function launch(world: Awaited<ReturnType<typeof setup>>) {
	return world.credentials.launch({
		userId: "U_mona",
		expiresAt: new Date(world.now().getTime() + 86_400_000 * 60),
	});
}

/** OpenAI's answer to a request with a key that is not valid. */
function invalid() {
	return Response.json({
		error: {
			message: "Incorrect API key provided.",
			type: "invalid_request_error",
			code: "invalid_api_key",
		},
	}, { status: 401 });
}

describe("keys Chopin knows won't work", () => {
	/** A world whose OpenAI answers each request with the next of `answers`, or `ok`. */
	async function refusing() {
		let world = await setup();
		let answers: Array<() => Response | Promise<Response>> = [];
		let openai = provider(() => answers.shift()?.() ?? Response.json({ ok: true }));
		let proxied = aiProxy({ credentials: world.credentials, upstreams: { openai: openai.url } });
		let send = (grant: AiProviderGrant) => {
			let url = new URL(`${grant.baseUrl}/responses`);
			return proxied(
				new Request(url, {
					method: "POST",
					body: "{}",
					headers: { authorization: `Bearer ${grant.placeholder}`, ...runner(grant) },
				}),
				url,
			);
		};
		let launchOpenai = async () => {
			let launched = await world.credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
			return {
				grant: launched.grants.find(isOpenai),
				withheld: launched.withheld.filter(entry => entry.provider === "openai"),
			};
		};
		let summary = async () =>
			((await (await world.api("/api/ai/credentials", world.mona)).json()) as AiCredentialList)
				.credentials.find(entry => entry.provider === "openai");
		return { world, answers, openai, send, launchOpenai, summary };
	}

	it("stops offering a key its provider refused as invalid and says it needs connecting again, but not for a rate limit or one model's refusal", async () => {
		let { world, answers, openai, send, launchOpenai, summary } = await refusing();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { grant } = await launchOpenai();
		let refusals = [
			() =>
				Response.json({ error: { code: "rate_limit_exceeded" } }, {
					status: 429,
					headers: { "retry-after": "1" },
				}),
			() =>
				Response.json({ error: { code: "model_not_found", type: "invalid_request_error" } }, {
					status: 404,
				}),
		];
		for (let refusal of refusals) {
			answers.push(refusal);
			let answered = await send(grant!);
			expect(answered.status).toBeGreaterThanOrEqual(400);
			expect((await launchOpenai()).grant).toBeDefined();
			expect(await summary()).not.toHaveProperty("rejectedAt");
		}

		answers.push(invalid);
		let refused = await send(grant!);
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(await launchOpenai()).toEqual({
			grant: undefined,
			withheld: [{ provider: "openai", reason: "key-unusable" }],
		});
		expect(await summary()).toMatchObject({
			suffix: "6789",
			rejectedAt: world.now().toISOString(),
		});

		await world.connect(world.mona, "openai", {
			kind: "api-key",
			secret: "sk-replacement-openai-key-4321",
		});
		expect(await summary()).not.toHaveProperty("rejectedAt");
		let again = (await launchOpenai()).grant!;
		expect((await send(again)).status).toBe(200);
		expect(openai.seen.at(-1)!.headers.authorization).toBe("Bearer sk-replacement-openai-key-4321");
	});

	it("keeps offering a verified replacement when the provider refuses the key it replaced only afterwards", async () => {
		let { world, answers, openai, send, launchOpenai, summary } = await refusing();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { grant } = await launchOpenai();
		let arrived = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		answers.push(async () => {
			arrived.resolve();
			await release.promise;
			return invalid();
		});
		let late = send(grant!);
		await arrived.promise;
		await world.connect(world.mona, "openai", {
			kind: "api-key",
			secret: "sk-replacement-openai-key-4321",
		});
		release.resolve();
		expect((await late).status).toBe(401);
		expect(openai.seen.map(seen => seen.headers.authorization)).toEqual([`Bearer ${OPENAI_KEY}`]);

		expect(await summary()).not.toHaveProperty("rejectedAt");
		let replaced = await launchOpenai();
		expect(replaced.withheld).toEqual([]);
		expect((await send(replaced.grant!)).status).toBe(200);
	});

	it("offers no key this deployment's encryption key can't open, and the key it was saved under still opens it", async () => {
		let { world } = await refusing();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let deployment = (fill: number) =>
			new RunnerCredentials({
				storage: world.storage,
				key: new Uint8Array(32).fill(fill),
				origin: ORIGIN,
				clock: world.now,
				githubToken: async () => undefined,
				copilotToken: async () => undefined,
				lease: () => world.lease,
			}).launch({ userId: "U_mona", expiresAt: new Date(world.now().getTime() + 3_600_000) });
		let other = await deployment(6);
		expect(other.grants).toEqual([]);
		expect(other.withheld).toContainEqual({ provider: "openai", reason: "key-unusable" });
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(0);

		let same = await deployment(5);
		expect(same.grants.map(entry => entry.provider)).toEqual(["openai"]);
	});
});

describe("what a launch is given", () => {
	it("gives no Copilot placeholder while Chopin can't read the person's GitHub sign-in", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		expect((await launch(world)).grants.map(grant => grant.provider)).toEqual(["github-copilot"]);
		world.advance(31 * 86_400_000);
		expect(await launch(world)).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "sign-in-unavailable" }],
		});

		await world.credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { grants } = await launch(world);
		expect(grants.map(grant => grant.provider)).toEqual(["openai"]);
		expect(
			(await world.call(grants[0]!, "/models", {
				headers: { authorization: `Bearer ${grants[0]!.placeholder}` },
			})).status,
		).toBe(200);
	});

	it("asks GitHub afresh at each launch, and gives no Copilot placeholder when it can't say", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let listed = await (await world.api("/api/ai/credentials", world.mona)).json();
		expect(listed).toMatchObject({ credentials: [{ copilotAccess: "access" }] });

		world.entitled.set("ghu_mona_signed_in", 403);
		expect(await launch(world)).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "no-copilot-access" }],
		});
		world.entitled.set("ghu_mona_signed_in", 502);
		expect(await launch(world)).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "copilot-unavailable" }],
		});
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(0);
	});

	it("gives nothing for a key removed while the launch was being prepared", async () => {
		let world = await setup();
		world.entitled.set("ghu_mona_signed_in", 404);
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let store = world.storage.aiCredentials;
		let list = store.list.bind(store);
		let removing: string[] = ["openai"];
		store.list = async userId => {
			let listed = await list(userId);
			for (let provider of removing.splice(0)) {
				await store.delete(world.lease, userId, provider as "openai" | "anthropic");
			}
			return listed;
		};
		let { grants } = await launch(world);
		expect(grants.map(grant => grant.provider)).toEqual(["anthropic"]);
		expect(
			(await world.call(grants[0]!, "/v1/models", {
				headers: { "x-api-key": grants[0]!.placeholder },
			})).status,
		).toBe(200);

		removing = ["anthropic"];
		expect((await launch(world)).grants).toEqual([]);
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(1);
	});

	it("gives nothing when the last key goes while a launch takes back a key removed after it saved its placeholders", async () => {
		let world = await setup();
		world.entitled.set("ghu_mona_signed_in", 404);
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.mona, "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let keys = world.storage.aiCredentials;
		let placeholders = world.storage.aiPlaceholders;
		let put = placeholders.put.bind(placeholders);
		let deleteLaunch = placeholders.deleteLaunch.bind(placeholders);
		let puts = 0;
		placeholders.put = async rows => {
			let stored = await put(rows);
			if (++puts === 1) await keys.delete(world.lease, "U_mona", "anthropic");
			return stored;
		};
		placeholders.deleteLaunch = async (lease, launchId) => {
			let removing = keys.delete(lease, "U_mona", "openai");
			let removed = await deleteLaunch(lease, launchId);
			await removing;
			return removed;
		};

		let launched = await launch(world);
		expect(await keys.list("U_mona")).toEqual([]);
		expect(launched.grants).toEqual([]);
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(0);
	});
});

describe("which providers a launch is given while they change", () => {
	/** A world whose GitHub answers Copilot token requests as `answer` says, held while `hold` is set. */
	async function changing() {
		let world = await setup();
		let state = {
			access: true,
			hold: undefined as PromiseWithResolvers<void> | undefined,
			asked: Promise.withResolvers<void>(),
		};
		let credentials = new RunnerCredentials({
			storage: world.storage,
			key: new Uint8Array(32).fill(5),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => "ghu_mona",
			copilotToken: async () => {
				let access = state.access;
				let hold = state.hold;
				if (hold) {
					state.hold = undefined;
					state.asked.resolve();
					await hold.promise;
				}
				return access
					? { token: "tid=1", expiresAt: world.now().getTime() + 1_800_000 }
					: undefined;
			},
			upstreams: { openai: world.keyChecks.openai.url, anthropic: world.keyChecks.anthropic.url },
			lease: () => world.lease,
		});
		let launch = (on: Pick<AiLaunch, "machineId" | "channelId"> = {}) =>
			credentials.launch({
				userId: "U_mona",
				...on,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
		/** Starts a launch and returns once it is asking GitHub about Copilot, held there. */
		let held = async (on: Pick<AiLaunch, "machineId" | "channelId"> = {}) => {
			state.hold = Promise.withResolvers();
			state.asked = Promise.withResolvers();
			let release = state.hold;
			let pending = launch(on);
			await state.asked.promise;
			return { pending, release: () => release.resolve() };
		};
		let rows = () => world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15));
		return { world, credentials, state, launch, held, rows };
	}

	it("withholds Copilot that a newer Check again refused while the launch was prepared, and gives the verified key alone", async () => {
		let { credentials, state, held } = await changing();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let launching = await held();
		state.access = false;
		expect(await credentials.check("U_mona", "ghu_mona")).toMatchObject({ copilotAccess: "none" });
		launching.release();
		let launched = await launching.pending;
		expect(launched.grants.map(grant => grant.provider)).toEqual(["openai"]);
		expect(launched.withheld).toEqual([{
			provider: "github-copilot",
			reason: "no-copilot-access",
		}]);
	});

	it("gives a key connected while the launch was prepared, though it had nothing else to give", async () => {
		let { credentials, state, held } = await changing();
		state.access = false;
		let launching = await held();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		launching.release();
		let launched = await launching.pending;
		expect(launched.grants.map(grant => grant.provider)).toEqual(["openai"]);
		expect(launched.withheld).toEqual([{
			provider: "github-copilot",
			reason: "no-copilot-access",
		}]);
	});

	it("gives nothing and keeps nothing for a launch whose document was archived while it was prepared, restored or not, and a fresh launch works after the restore", async () => {
		let { world, credentials, held, launch, rows } = await changing();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let document = { id: world.channel.id };
		let archivals: Array<() => Promise<unknown>> = [
			() => world.storage.channels.archive({ ...document, now: world.now(), lease: world.lease }),
			async () => {
				await world.storage.channels.archive({ ...document, now: world.now(), lease: world.lease });
				await world.storage.channels.restore({ ...document, now: world.now() });
			},
		];
		for (let archive of archivals) {
			let launching = await held({ channelId: document.id });
			await archive();
			launching.release();
			let launched = await launching.pending;
			expect(launched.grants).toEqual([]);
			expect(await rows()).toBe(0);
			await world.storage.channels.restore({ ...document, now: world.now() });
		}

		let fresh = await launch({ channelId: document.id });
		expect(fresh.grants.map(grant => grant.provider)).toEqual(["github-copilot", "openai"]);
		let openai = fresh.grants.find(isOpenai)!;
		let proxied = aiProxy({ credentials, upstreams: { openai: world.upstreams.openai.url } });
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		expect(answer.status).toBe(200);
		expect(await rows()).toBe(2);
	});

	it("gives nothing and keeps nothing for a launch whose document was archived after its final read of the document and before its final read of the person's accounts, and a fresh launch works after the restore", async () => {
		let { world, credentials, launch, rows } = await changing();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let document = { id: world.channel.id };
		let accounts = world.storage.aiCredentials;
		let placeholders = world.storage.aiPlaceholders;
		let list = accounts.list.bind(accounts);
		let generation = placeholders.generation.bind(placeholders);
		let lists = 0;
		let generations = 0;
		let documentRead = Promise.withResolvers<void>();
		let accountsHeld = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		// The launch reads the document's generation as it begins and last before it publishes.
		placeholders.generation = async channelId => {
			let read = await generation(channelId);
			if (++generations === 2) documentRead.resolve();
			return read;
		};
		// It reads the person's accounts as it is prepared and last before it publishes.
		accounts.list = async userId => {
			let listed = await list(userId);
			if (++lists === 2) {
				accountsHeld.resolve();
				await release.promise;
			}
			return listed;
		};
		let pending = launch({ channelId: document.id });
		await Promise.all([documentRead.promise, accountsHeld.promise]);
		await world.storage.channels.archive({ ...document, now: world.now(), lease: world.lease });
		release.resolve();
		let launched = await pending;
		expect(launched.grants).toEqual([]);
		expect(await rows()).toBe(0);

		accounts.list = list;
		placeholders.generation = generation;
		await world.storage.channels.restore({ ...document, now: world.now() });
		let fresh = await launch({ channelId: document.id });
		expect(fresh.grants.map(grant => grant.provider)).toEqual(["github-copilot", "openai"]);
		let openai = fresh.grants.find(isOpenai)!;
		let proxied = aiProxy({ credentials, upstreams: { openai: world.upstreams.openai.url } });
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		expect(answer.status).toBe(200);
	});

	it("gives nothing and keeps nothing for a launch whose machine was revoked after its final read of the machine and before its final read of the person's accounts", async () => {
		let { world, credentials, launch, rows } = await changing();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine"),
		});
		let accounts = world.storage.aiCredentials;
		let machines = world.storage.machines;
		let list = accounts.list.bind(accounts);
		let get = machines.get.bind(machines);
		let lists = 0;
		let machineRead = Promise.withResolvers<void>();
		let accountsHeld = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		machines.get = async id => {
			let read = await get(id);
			machineRead.resolve();
			return read;
		};
		accounts.list = async userId => {
			let listed = await list(userId);
			if (++lists === 2) {
				accountsHeld.resolve();
				await release.promise;
			}
			return listed;
		};
		let pending = launch({ machineId: machine.id });
		await Promise.all([machineRead.promise, accountsHeld.promise]);
		expect(await world.machines.revoke(machine.id, "U_mona")).toBe(true);
		release.resolve();
		expect((await pending).grants).toEqual([]);
		expect(await rows()).toBe(0);
	});

	it("asks for the launch again, never giving nothing, when one provider changes at every attempt while another's verified key stays", async () => {
		let { world, credentials, state, launch, rows } = await changing();
		state.access = false;
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		await credentials.connect("U_mona", "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
		let store = world.storage.aiCredentials;
		let list = store.list.bind(store);
		let reads = 0;
		store.list = async userId => {
			let listed = await list(userId);
			// Each attempt reads twice: as it is prepared, and last, as it is published.
			if (++reads % 2 === 0) {
				let anthropic = (await store.get(userId, "anthropic"))!;
				await store.put(world.lease, {
					...anthropic,
					updatedAt: new Date(anthropic.updatedAt.getTime() + 1),
				});
			}
			return listed;
		};
		let outcome = await launch().then(launched => launched, (err: unknown) => err);
		expect(outcome).toBeInstanceOf(AiCredentialError);
		expect((outcome as AiCredentialError).status).toBe(503);
		expect(await rows()).toBe(0);

		store.list = list;
		expect((await launch()).grants.map(grant => grant.provider)).toEqual(["openai", "anthropic"]);
	});

	it("gives nothing for the last key removed after the launch's final read of the person's keys", async () => {
		let { world, credentials, state, launch, rows } = await changing();
		state.access = false;
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let store = world.storage.aiCredentials;
		let list = store.list.bind(store);
		let lists = 0;
		store.list = async userId => {
			let listed = await list(userId);
			if (++lists === 2) await credentials.disconnect("U_mona", "openai");
			return listed;
		};
		let launched = await launch();
		expect(await store.get("U_mona", "openai")).toBeUndefined();
		expect(launched.grants).toEqual([]);
		expect(await rows()).toBe(0);
	});
});

describe("a Copilot answer another check gets while a launch is prepared", () => {
	/**
	 * A world whose GitHub answers each Copilot token request when the test resolves it, unless
	 * `seat` says how to answer at once, and whose sign-in token is whichever `signIn` names.
	 */
	async function answering() {
		let world = await setup();
		let state = {
			seat: "access" as "access" | "none" | undefined,
			signIn: "ghu_mona_1",
			asks: [] as Array<PromiseWithResolvers<"access" | "none">>,
			asked: Promise.withResolvers<void>(),
		};
		let token = (githubToken: string, seat: "access" | "none") =>
			seat === "access"
				? { token: `tid=${githubToken}`, expiresAt: world.now().getTime() + 1_800_000 }
				: undefined;
		let credentials = new RunnerCredentials({
			storage: world.storage,
			key: new Uint8Array(32).fill(5),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => state.signIn,
			copilotToken: async githubToken => {
				if (state.seat) return token(githubToken, state.seat);
				let answer = Promise.withResolvers<"access" | "none">();
				state.asks.push(answer);
				state.asked.resolve();
				return token(githubToken, await answer.promise);
			},
			upstreams: { openai: world.keyChecks.openai.url, anthropic: world.keyChecks.anthropic.url },
			lease: () => world.lease,
		});
		/** Resolves once GitHub has been asked one question more than `count`, and returns it. */
		let question = async (count: number) => {
			while (state.asks.length <= count) {
				state.asked = Promise.withResolvers();
				await state.asked.promise;
			}
			return state.asks[count]!;
		};
		let sent: string[] = [];
		let proxied = aiProxy({
			credentials,
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(new Headers(init?.headers).get("authorization") ?? "");
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		let call = (copilot: AiProviderGrant) => {
			let url = new URL(`${copilot.baseUrl}/chat/completions`);
			return proxied(
				new Request(url, {
					method: "POST",
					body: "{}",
					headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
				}),
				url,
			);
		};
		/** Holds the next launch once its placeholders are about to be saved, after its answer. */
		let holdBeforeSaving = () => {
			let placeholders = world.storage.aiPlaceholders;
			let put = placeholders.put.bind(placeholders);
			let reached = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			placeholders.put = async rows => {
				placeholders.put = put;
				reached.resolve();
				await release.promise;
				return put(rows);
			};
			return { reached: reached.promise, release: () => release.resolve() };
		};
		let launch = () =>
			credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
		return { world, credentials, state, question, sent, call, holdBeforeSaving, launch };
	}

	/**
	 * The orders in which a new launch's answer (access) and an existing launch's request (no seat,
	 * for the same sign-in through another of its tokens) can be asked and answered. An answer that
	 * reaches Chopin after one of the other kind it was asked before may have been decided first, so
	 * Chopin asks GitHub again (`asksAgain`), which by then finds no seat.
	 */
	let orders: Record<
		string,
		(steps: {
			launchAsks: () => Promise<PromiseWithResolvers<"access" | "none">>;
			requestAsks: () => Promise<PromiseWithResolvers<"access" | "none">>;
			asksAgain: () => Promise<PromiseWithResolvers<"access" | "none">>;
			launchHeld: () => Promise<void>;
		}) => Promise<void>
	> = {
		"the refusal is asked and answered after the launch's answer": async steps => {
			(await steps.launchAsks()).resolve("access");
			await steps.launchHeld();
			(await steps.requestAsks()).resolve("none");
		},
		"the refusal is answered before the launch's earlier question": async steps => {
			let launchAnswer = await steps.launchAsks();
			(await steps.requestAsks()).resolve("none");
			launchAnswer.resolve("access");
			(await steps.asksAgain()).resolve("none");
			await steps.launchHeld();
		},
		"the refusal is asked before the launch's question and answered after it": async steps => {
			let requestAnswer = await steps.requestAsks();
			(await steps.launchAsks()).resolve("access");
			await steps.launchHeld();
			requestAnswer.resolve("none");
			(await steps.asksAgain()).resolve("none");
		},
	};

	for (let [order, run] of Object.entries(orders)) {
		it(`gives a launch the verified key alone once an existing launch's request finds no seat for the same sign-in: ${order}`, async () => {
			let { credentials, state, question, sent, call, holdBeforeSaving, launch } =
				await answering();
			await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
			let existing = (await launch()).grants.find(grant => grant.provider === "github-copilot")!;
			state.seat = undefined;
			let asked = 0;
			let pending: Promise<Awaited<ReturnType<typeof launch>>> | undefined;
			let refused: Promise<Response> | undefined;
			let held = holdBeforeSaving();
			await run({
				launchAsks: async () => {
					state.signIn = "ghu_mona_2";
					pending = launch();
					return question(asked++);
				},
				requestAsks: async () => {
					state.signIn = "ghu_mona_3";
					refused = call(existing);
					return question(asked++);
				},
				asksAgain: () => question(asked++),
				launchHeld: () => held.reached,
			});
			let answer = await refused!;
			expect(answer.status).toBe(403);
			expect(await code(answer)).toBe("no-copilot-access");
			state.seat = "none";
			held.release();
			let launched = await pending!;
			expect(launched.grants.map(grant => grant.provider)).toEqual(["openai"]);
			expect(launched.withheld).toEqual([{
				provider: "github-copilot",
				reason: "no-copilot-access",
			}]);
			expect(sent).toEqual([]);
		});
	}

	it("keeps Copilot for a launch when an existing launch's request finds GitHub can't answer, which says nothing of the seat", async () => {
		let { credentials, state, question, call, holdBeforeSaving, launch } = await answering();
		await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
		let existing = (await launch()).grants.find(grant => grant.provider === "github-copilot")!;
		state.seat = undefined;
		let held = holdBeforeSaving();
		state.signIn = "ghu_mona_2";
		let pending = launch();
		(await question(0)).resolve("access");
		await held.reached;
		state.signIn = "ghu_mona_3";
		let failed = call(existing);
		(await question(1)).reject(new Error("GitHub can't be reached"));
		expect(await code(await failed)).toBe("copilot-unavailable");
		held.release();
		expect((await pending).grants.map(grant => grant.provider)).toEqual([
			"github-copilot",
			"openai",
		]);
	});
});

describe("GitHub Copilot through the proxy", () => {
	it("never sends the GitHub token, nor any request outside the model API, to Copilot's host", async () => {
		let world = await setup();
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let copilot = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants[0]!;
		let sent: Array<{ url: string; authorization: string | null }> = [];
		let proxied = aiProxy({
			credentials: world.credentials,
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				sent.push({
					url: String(input),
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		let call = (path: string, method = "POST") => {
			let url = new URL(`${copilot.baseUrl}${path}`);
			return proxied(
				new Request(url, {
					method,
					headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
					...(method === "GET" ? {} : { body: '{"method":"tools/list"}' }),
				}),
				url,
			);
		};
		for (
			let path of [
				"/mcp/",
				"/mcp",
				"/models/../mcp/",
				"/%6Dcp/",
				"/models/x%2F..%2F..%2Fmcp/policy",
				"/chat/completions/",
				"//mcp/",
			]
		) {
			let refused = await call(path);
			expect(refused.status).toBe(404);
			expect(await code(refused)).toBe("route");
		}
		expect((await call("/models", "DELETE")).status).toBe(404);
		expect(sent).toEqual([]);

		expect((await call("/chat/completions")).status).toBe(200);
		expect((await call("/models", "GET")).status).toBe(200);
		expect(sent).toEqual([
			{
				url: "https://api.githubcopilot.com/chat/completions",
				authorization: "Bearer tid=copilot;for=ghu_mona_signed_in",
			},
			{
				url: "https://api.githubcopilot.com/models",
				authorization: "Bearer tid=copilot;for=ghu_mona_signed_in",
			},
		]);
	});

	it("sends to the account's own Copilot host when GitHub names one", async () => {
		let world = await setup();
		let sent: string[] = [];
		let credentials = new RunnerCredentials({
			storage: world.storage,
			key: new Uint8Array(32).fill(5),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => "ghu_mona",
			copilotToken: async () => ({
				token: "tid=business",
				expiresAt: world.now().getTime() + 1_800_000,
				api: "https://api.business.githubcopilot.com",
			}),
			lease: () => world.lease,
		});
		await credentials.connect("U_mona", "github-copilot", { kind: "github-sign-in" });
		let copilot = (await credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants[0]!;
		let proxied = aiProxy({
			credentials,
			fetch: (async (input: string | URL | Request) => {
				sent.push(String(input));
				return Response.json({ data: [] });
			}) as typeof fetch,
		});
		let url = new URL(`${copilot.baseUrl}/models`);
		await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
			}),
			url,
		);
		expect(sent).toEqual(["https://api.business.githubcopilot.com/models"]);
	});

	it("asks GitHub for the next Copilot token before the one it holds expires", async () => {
		let world = await setup();
		world.copilotLifetime.seconds = 180;
		await world.connect(world.mona, "github-copilot", { kind: "github-sign-in" });
		let copilot = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants[0]!;
		let models = () =>
			world.call(copilot, "/models", {
				headers: { authorization: `Bearer ${copilot.placeholder}` },
			});
		let exchanges = world.githubApi.seen.length;
		expect((await models()).status).toBe(200);
		expect(world.githubApi.seen).toHaveLength(exchanges);
		world.advance(125_000);
		expect((await models()).status).toBe(200);
		expect(world.githubApi.seen).toHaveLength(exchanges + 1);

		world.entitled.set("ghu_mona_signed_in", 500);
		world.advance(125_000);
		let failed = await models();
		expect(failed.status).toBe(502);
		expect(await code(failed)).toBe("copilot-unavailable");
		expect(world.upstreams.copilot.seen).toHaveLength(2);
	});
});

describe("which launch presents a placeholder", () => {
	it("reaches the provider only for the launch the placeholder was given to, on one runner", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		await world.connect(world.hubot, "openai", { kind: "api-key", secret: OTHER_OPENAI_KEY });
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine"),
		});
		let launch = (userId: string) =>
			world.credentials.launch({
				userId,
				machineId: machine.id,
				channelId: world.channel.id,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
		let models = (placeholder: string, launchToken: string | undefined) =>
			world.router.handle(
				new Request(`${ORIGIN}/api/v1/ai/openai/v1/models`, {
					headers: {
						authorization: `Bearer ${placeholder}`,
						...(launchToken === undefined ? {} : { [AI_LAUNCH_HEADER]: launchToken }),
					},
				}),
			) as Promise<Response>;

		let alice = await launch("U_mona");
		let bob = await launch("U_hubot");
		let alicePlaceholder = alice.grants.find(isOpenai)!.placeholder;
		for (
			let [launchToken, refusal] of [
				[bob.launchToken, "other-launch"],
				[undefined, "no-launch"],
				["", "no-launch"],
				["chopin_launch_" + "x".repeat(43), "other-launch"],
			] as const
		) {
			let refused = await models(alicePlaceholder, launchToken);
			expect(refused.status).toBe(401);
			expect(await code(refused)).toBe(refusal);
		}
		expect(world.upstreams.openai.seen).toEqual([]);
		expect((await models(alicePlaceholder, alice.launchToken)).status).toBe(200);
		expect((await models(bob.grants.find(isOpenai)!.placeholder, bob.launchToken)).status).toBe(
			200,
		);
		expect(world.upstreams.openai.seen.map(seen => seen.headers.authorization)).toEqual([
			`Bearer ${OPENAI_KEY}`,
			`Bearer ${OTHER_OPENAI_KEY}`,
		]);

		let second = await launch("U_mona");
		let refused = await models(alicePlaceholder, second.launchToken);
		expect(refused.status).toBe(401);
		expect(await code(refused)).toBe("other-launch");
		let reversed = await models(second.grants.find(isOpenai)!.placeholder, alice.launchToken);
		expect(await code(reversed)).toBe("other-launch");
		expect(world.upstreams.openai.seen).toHaveLength(2);
		expect(world.upstreams.openai.seen.every(seen => !seen.headers[AI_LAUNCH_HEADER])).toBe(true);
	});
});

describe("Copilot tokens that expire", () => {
	async function copilotWorld(
		exchange: (githubToken: string) => Promise<CopilotToken | undefined>,
		/** The clock the proxy's transport reads as it takes a send, when not the system's. */
		transport?: () => number,
	) {
		let world = await setup();
		let sent: string[] = [];
		let credentials = new RunnerCredentials({
			storage: world.storage,
			key: new Uint8Array(32).fill(5),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => "ghu_mona",
			copilotToken: exchange,
			upstreams: { openai: world.keyChecks.openai.url, anthropic: world.keyChecks.anthropic.url },
			lease: () => world.lease,
		});
		await credentials.connect("U_mona", "github-copilot", { kind: "github-sign-in" });
		let proxied = aiProxy({
			credentials,
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(new Headers(init?.headers).get("authorization") ?? "");
				return Response.json({ ok: true });
			}) as typeof fetch,
			...(transport ? { clock: transport } : {}),
		});
		let launch = (on: Partial<Pick<AiLaunch, "machineId" | "channelId" | "expiresAt">> = {}) =>
			credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 3_600_000),
				...on,
			});
		let call = (copilot: AiProviderGrant, init: RequestInit = {}) => {
			let url = new URL(`${copilot.baseUrl}/chat/completions`);
			return proxied(
				new Request(url, {
					method: "POST",
					body: "{}",
					...init,
					headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
				}),
				url,
			);
		};
		return { world, credentials, proxied, sent, launch, call };
	}

	it("decides a send against the launch's and the token's deadlines on the clock reading the transport takes it at, renewing a token found expired then", async () => {
		let readings: number[] = [];
		let lifetimes: number[] = [];
		let issued = 0;
		let { world, sent, launch, call } = await copilotWorld(
			async () => ({
				token: `tid=${++issued}`,
				expiresAt: world.now().getTime() + (lifetimes.shift() ?? 1_800_000),
			}),
			() => readings.length > 1 ? readings.shift()! : readings[0]!,
		);
		let deadline = new Date(world.now().getTime() + 60_000);
		let short = (await launch({ expiresAt: deadline })).grants[0]!;
		world.advance(60_000 - 1);
		readings = [deadline.getTime()];
		let refused = await call(short);
		expect(refused.status).toBe(401);
		expect(await code(refused)).toBe("launch-ended");
		expect(sent).toEqual([]);
		readings = [deadline.getTime() - 1];
		expect((await call(short)).status).toBe(200);
		expect(sent).toEqual(["Bearer tid=1"]);

		let long = (await launch()).grants[0]!;
		world.advance(6 * 60_000);
		lifetimes = [1];
		let tokenDeadline = world.now().getTime() + 1;
		readings = [tokenDeadline, tokenDeadline - 1];
		let renewed = await call(long);
		expect(renewed.status).toBe(200);
		expect(sent).toEqual(["Bearer tid=1", `Bearer tid=${issued}`]);
		expect(issued).toBe(4);
	});

	it("hands the transport the launch's and the token's deadlines, and the transport entered at either refuses the launch or renews the token before it takes the request", async () => {
		let expiries: number[] = [];
		let { world, credentials, launch } = await copilotWorld(async () => {
			let expiresAt = world.now().getTime() + 1_800_000 + expiries.length;
			expiries.push(expiresAt);
			return { token: `tid=${expiries.length}`, expiresAt };
		});
		/** The readings the transport's clock is entered at, in turn; the world's clock after them. */
		let entries: number[] = [];
		let handed: AiDeadlines[] = [];
		let taken: string[] = [];
		let send = (async (_input: string | URL | Request, init?: RequestInit) => {
			taken.push(new Headers(init?.headers).get("authorization") ?? "");
			return Response.json({ ok: true });
		}) as typeof fetch;
		let submit = aiTransport(send, () => entries.shift() ?? world.now().getTime());
		let recording: AiTransport = (target, init, deadlines) => {
			handed.push(deadlines);
			return submit(target, init, deadlines);
		};
		let proxied = aiProxy({ credentials, transport: recording, fetch: send });
		let call = (copilot: AiProviderGrant) => {
			let url = new URL(`${copilot.baseUrl}/chat/completions`);
			return proxied(
				new Request(url, {
					method: "POST",
					body: "{}",
					headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
				}),
				url,
			);
		};

		let deadline = world.now().getTime() + 60_000;
		let short = (await launch({ expiresAt: new Date(deadline) })).grants[0]!;
		world.advance(60_000 - 1);
		entries = [deadline];
		let refused = await call(short);
		expect(refused.status).toBe(401);
		expect(await code(refused)).toBe("launch-ended");
		expect(handed).toEqual([{ launch: deadline, token: expiries[0]! }]);
		expect(taken).toEqual([]);

		let ends = world.now().getTime() + 3_600_000;
		let long = (await launch()).grants[0]!;
		entries = [expiries[1]!];
		let renewed = await call(long);
		expect(renewed.status).toBe(200);
		expect(handed.slice(1)).toEqual([
			{ launch: ends, token: expiries[1]! },
			{ launch: ends, token: expiries[2]! },
		]);
		expect(taken).toEqual(["Bearer tid=3"]);
	});

	it("never hands the provider a Copilot token GitHub gave already expired", async () => {
		let expired = false;
		let issued = 0;
		let { world, sent, launch, call } = await copilotWorld(async () => ({
			token: `tid=${++issued}`,
			expiresAt: expired ? world.now().getTime() - 1 : world.now().getTime() + 1_800_000,
		}));
		let copilot = (await launch()).grants[0]!;
		expect((await call(copilot)).status).toBe(200);

		expired = true;
		world.advance(30 * 60_000);
		let refused = await call(copilot);
		expect(refused.status).toBe(502);
		expect(await code(refused)).toBe("copilot-unavailable");
		expect(await launch()).toMatchObject({
			grants: [],
			withheld: [{ provider: "github-copilot", reason: "copilot-unavailable" }],
		});
		expect(sent).toEqual(["Bearer tid=1"]);
	});

	it("never hands the provider a Copilot token that expired while GitHub was answering", async () => {
		let slow: PromiseWithResolvers<CopilotToken | undefined> | undefined;
		let asked = Promise.withResolvers<void>();
		let { world, sent, launch, call } = await copilotWorld(async () => {
			if (!slow) return { token: "tid=1", expiresAt: world.now().getTime() + 1_800_000 };
			asked.resolve();
			return slow.promise;
		});
		let copilot = (await launch()).grants[0]!;
		world.advance(6 * 60_000);
		slow = Promise.withResolvers();
		let pending = call(copilot);
		await asked.promise;
		let issuedAt = world.now().getTime();
		world.advance(2_000);
		slow.resolve({ token: "tid=late", expiresAt: issuedAt + 1_000 });
		let refused = await pending;
		expect(refused.status).toBe(502);
		expect(await code(refused)).toBe("copilot-unavailable");
		expect(sent).toEqual([]);
	});

	it("renews a Copilot token that expired while the request's body arrived, and never sends the old one", async () => {
		let issued = 0;
		let { world, sent, launch, call } = await copilotWorld(async () => ({
			token: `tid=${++issued}`,
			expiresAt: world.now().getTime() + 90_000,
		}));
		let copilot = (await launch()).grants[0]!;
		let reading = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				reading.resolve();
				await release.promise;
				controller.enqueue(new TextEncoder().encode("{}"));
				controller.close();
			},
		}, { highWaterMark: 0 });
		let pending = call(copilot, { body, duplex: "half" } as RequestInit);
		await reading.promise;
		world.advance(120_000);
		release.resolve();
		expect((await pending).status).toBe(200);
		expect(issued).toBe(2);
		expect(sent).toEqual(["Bearer tid=2"]);
	});

	it("gives no grants to a launch whose deadline came while GitHub was asked about Copilot", async () => {
		let asking = 0;
		let { world, credentials } = await copilotWorld(async () => {
			world.advance(asking);
			return { token: "tid=1", expiresAt: world.now().getTime() + 1_800_000 };
		});
		let launchTaking = (ms: number) => {
			asking = ms;
			return credentials.launch({
				userId: "U_mona",
				expiresAt: new Date(world.now().getTime() + 60_000),
			});
		};
		expect((await launchTaking(60_000)).grants).toEqual([]);
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(0);

		let before = await launchTaking(59_999);
		expect(before.grants.map(grant => grant.provider)).toEqual(["github-copilot"]);
		expect(await world.storage.aiPlaceholders.deleteExpired(new Date(8.64e15))).toBe(1);
	});

	for (let kind of ["exchanged", "raw"] as const) {
		it(`renews Copilot access whose ${kind} token expired while a launch stored its placeholders before handing it out, and gives no Copilot when GitHub can't renew it`, async () => {
			let world = await setup();
			let token = "ghu_mona_signed_in";
			// GitHub's Copilot token lasts a second; Copilot takes a GitHub token itself for 30 minutes.
			let life = kind === "raw" ? 30 * 60_000 : 1_000;
			world.copilotLifetime.seconds = 1;
			let usable = (yes: boolean) => {
				if (yes) world.entitled.delete(token);
				else world.entitled.set(token, 503);
				if (kind === "raw") world.notExchanged.add(token);
				if (yes && kind === "raw") world.takenRaw.add(token);
				else world.takenRaw.delete(token);
			};
			usable(true);
			let storing = 0;
			let stored: (() => void) | undefined;
			let placeholders = world.storage.aiPlaceholders;
			let put = placeholders.put.bind(placeholders);
			placeholders.put = async rows => {
				world.advance(storing);
				storing = 0;
				let then = stored;
				stored = undefined;
				then?.();
				return put(rows);
			};
			/** A launch whose first placeholders take `ms` to store, after which `then` happens. */
			let launchStoring = async (ms: number, then?: () => void) => {
				storing = ms;
				stored = then;
				let asked = world.githubApi.seen.length;
				let launched = await world.credentials.launch({
					userId: "U_mona",
					expiresAt: new Date(world.now().getTime() + 3_600_000),
				});
				return {
					grants: launched.grants.map(grant => grant.provider),
					asked: world.githubApi.seen.length - asked,
					kept: await placeholders.deleteExpired(new Date(8.64e15)),
				};
			};

			expect(await launchStoring(life - 1)).toEqual({
				grants: ["github-copilot"],
				asked: 1,
				kept: 1,
			});
			for (let ms of [life, life + 1]) {
				expect(await launchStoring(ms)).toEqual({ grants: ["github-copilot"], asked: 2, kept: 1 });
			}
			for (let ms of [life, life + 1]) {
				expect(await launchStoring(ms, () => usable(false))).toEqual({
					grants: [],
					asked: 2,
					kept: 0,
				});
				usable(true);
			}
		});
	}

	it("renews a Copilot token whose deadline came while its request was prepared, and never sends that one", async () => {
		let issued = 0;
		let { world, proxied, sent, launch } = await copilotWorld(async () => ({
			token: `tid=${++issued}`,
			expiresAt: world.now().getTime() + 90_000,
		}));
		let copilot = (await launch()).grants[0]!;
		let url = new URL(`${copilot.baseUrl}/chat/completions`);
		let request = new Request(url, {
			method: "POST",
			body: "{}",
			headers: { authorization: `Bearer ${copilot.placeholder}`, ...runner(copilot) },
		});
		let signal = request.signal;
		let prepared = false;
		Object.defineProperty(request, "signal", {
			get() {
				if (!prepared) {
					prepared = true;
					world.advance(90_000);
				}
				return signal;
			},
		});
		let answer = await proxied(request, url);
		expect(prepared).toBe(true);
		expect(answer.status).toBe(200);
		expect(issued).toBe(2);
		expect(sent).toEqual(["Bearer tid=2"]);
	});

	it("sends a renewed Copilot token only when the account that gave it is the one the request was admitted with and the one connected at the send", async () => {
		let issued = 0;
		let { world, credentials, sent, launch, call } = await copilotWorld(async githubToken => ({
			token: `tid=${++issued};for=${githubToken}`,
			expiresAt: world.now().getTime() + 90_000,
		}));
		let store = world.storage.aiCredentials;
		let signIn = await store.get("U_mona", "github-copilot");
		await credentials.connect("U_mona", "github-copilot", {
			kind: "api-key",
			secret: "ghp_another_account_token",
		});
		let anotherAccount = await store.get("U_mona", "github-copilot");
		await store.put(world.lease, signIn!);
		let copilot = (await launch()).grants[0]!;

		let get = store.get.bind(store);
		/** The records the request reads: when admitted, when its token is renewed, and at the send. */
		let cases: Array<{ renewal?: typeof anotherAccount; sentWith?: string }> = [
			{ renewal: anotherAccount },
			{ sentWith: "ghu_mona" },
		];
		for (let { renewal, sentWith } of cases) {
			let reads: Array<"original" | "renewal" | "current"> = [];
			store.get = async (userId, provider) => {
				let label = (["original", "renewal", "current"] as const)[reads.length]!;
				reads.push(label);
				return label === "renewal" && renewal ? renewal : get(userId, provider);
			};
			let paused = pausedBody();
			let pending = call(copilot, { body: paused.body, duplex: "half" } as RequestInit);
			await paused.reading;
			world.advance(120_000);
			paused.release();
			let answer = await pending;
			store.get = get;
			expect(reads).toEqual(["original", "renewal", "current"]);
			if (sentWith) {
				expect(answer.status).toBe(200);
				expect(sent.at(-1)).toEndWith(`;for=${sentWith}`);
			} else {
				expect(answer.status).toBe(409);
				expect(await code(answer)).toBe("credential-changed");
			}
		}
		expect(sent).toHaveLength(1);
		expect(sent.join()).not.toContain("ghp_another_account_token");
	});

	it("sends nothing once the launch ended, its machine was revoked or its document archived while its Copilot token was renewed", async () => {
		let renewal:
			| { asked: PromiseWithResolvers<void>; answer: PromiseWithResolvers<void> }
			| undefined;
		let issued = 0;
		let { world, credentials, sent, launch, call } = await copilotWorld(async () => {
			if (renewal) {
				renewal.asked.resolve();
				await renewal.answer.promise;
			}
			return { token: `tid=${++issued}`, expiresAt: world.now().getTime() + 90_000 };
		});
		let cutoffs: Array<(launch: { launchId: string; machineId: string }) => Promise<unknown>> = [
			launch => credentials.end(launch.launchId),
			launch => world.storage.machines.revoke(world.lease, launch.machineId, "U_mona", world.now()),
			() =>
				world.storage.channels.archive({
					id: world.channel.id,
					now: world.now(),
					lease: world.lease,
				}),
		];
		for (let cutoff of cutoffs) {
			renewal = undefined;
			let { machine } = await world.machines.pair({
				userId: "U_mona",
				label: "studio",
				repositories: [],
				autoRun: false,
				grant: grant("ghu_machine"),
			});
			let launched = await launch({ machineId: machine.id, channelId: world.channel.id });
			let paused = pausedBody();
			let pending = call(launched.grants[0]!, { body: paused.body, duplex: "half" } as RequestInit);
			await paused.reading;
			world.advance(120_000);
			renewal = { asked: Promise.withResolvers(), answer: Promise.withResolvers() };
			paused.release();
			await renewal.asked.promise;
			await cutoff({ launchId: launched.launchId, machineId: machine.id });
			renewal.answer.resolve();
			let refused = await pending;
			expect(refused.status).toBe(401);
			expect(await code(refused)).toBe("launch-ended");
		}
		expect(sent).toEqual([]);
	});
});

/**
 * Holds the next read of a person's credential: it reads the row when it is asked, as a read that
 * reached storage first would, and returns it only once released.
 */
function holdNextRead(store: AiCredentialStore) {
	let get = store.get.bind(store);
	let reading = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	store.get = async (userId, provider) => {
		store.get = get;
		let read = await get(userId, provider);
		reading.resolve();
		await release.promise;
		return read;
	};
	return { reading: reading.promise, release: () => release.resolve() };
}

/** A request body that stops once it is first read, until it is released. */
function pausedBody() {
	let reading = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			reading.resolve();
			await release.promise;
			controller.enqueue(new TextEncoder().encode("{}"));
			controller.close();
		},
	}, { highWaterMark: 0 });
	return { body, reading: reading.promise, release: () => release.resolve() };
}

describe("the proxy's final handoff", () => {
	it("takes a key the provider echoes out of its headers and its body, even split across chunks", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		let middle = 9;
		let proxied = aiProxy({
			credentials: world.credentials,
			fetch: (async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							let encoder = new TextEncoder();
							controller.enqueue(encoder.encode(`{"echo":"${OPENAI_KEY.slice(0, middle)}`));
							controller.enqueue(encoder.encode(`${OPENAI_KEY.slice(middle)}","again":"`));
							controller.enqueue(encoder.encode(`${OPENAI_KEY}"}\n`));
							controller.close();
						},
					}),
					{
						headers: {
							"content-type": "application/json",
							"cache-control": `private, extension=${OPENAI_KEY}`,
							"x-echo": `Bearer ${OPENAI_KEY}`,
							[OPENAI_KEY]: "1",
							"x-request-id": "req_1",
						},
					},
				)) as unknown as typeof fetch,
		});
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		for (let [name, value] of answer.headers) {
			expect(`${name}: ${value}`).not.toContain(OPENAI_KEY);
		}
		expect(answer.headers.get("cache-control")).toBe("private, extension=[redacted]");
		expect(answer.headers.get("x-echo")).toBeNull();
		expect(answer.headers.get("x-request-id")).toBe("req_1");
		let text = await answer.text();
		expect(text).not.toContain(OPENAI_KEY);
		expect(JSON.parse(text)).toEqual({ echo: "[redacted]", again: "[redacted]" });
	});

	it("passes back no rate-limit header whose name holds the key, whatever its case", async () => {
		let world = await setup();
		let key = "sk-Inert-Fixture-KEY-0123456789";
		await world.connect(world.mona, "openai", { kind: "api-key", secret: key });
		let openai = (await launch(world)).grants.find(isOpenai)!;
		let proxied = aiProxy({
			credentials: world.credentials,
			fetch: (async () =>
				Response.json({ ok: true }, {
					headers: {
						[`x-ratelimit-${key}`]: "1",
						[`anthropic-ratelimit-${key}-tokens`]: "2",
						"x-ratelimit-remaining-requests": "99",
						"anthropic-ratelimit-tokens-remaining": "98",
					},
				})) as unknown as typeof fetch,
		});
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		expect(answer.status).toBe(200);
		for (let [name, value] of answer.headers) {
			expect(`${name}: ${value}`.toLowerCase()).not.toContain(key.toLowerCase());
		}
		expect(answer.headers.get("x-ratelimit-remaining-requests")).toBe("99");
		expect(answer.headers.get("anthropic-ratelimit-tokens-remaining")).toBe("98");
	});

	it("never emits the key that its replacement forms with the text around it, in a chunk, across chunks or in a header", async () => {
		let world = await setup();
		let cases: Array<[key: string, chunks: string[], header: string]> = [
			["sk[redacted]0123", ['{"a":"sk', "sk[red", 'acted]01230123"}'], "sksk[redacted]01230123"],
			["cted]-tail-0123", ['{"a":"cted]-tail-0123', '-tail-0123"}'], "cted]-tail-0123-tail-0123"],
		];
		for (let [key, chunks, header] of cases) {
			await world.connect(world.mona, "openai", { kind: "api-key", secret: key });
			let openai = (await launch(world)).grants.find(isOpenai)!;
			let proxied = aiProxy({
				credentials: world.credentials,
				fetch: (async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (let chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
								controller.close();
							},
						}),
						{ headers: { "content-type": "application/json", "x-request-id": header } },
					)) as unknown as typeof fetch,
			});
			let url = new URL(`${openai.baseUrl}/models`);
			let answer = await proxied(
				new Request(url, {
					headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
				}),
				url,
			);
			for (let [name, value] of answer.headers) expect(`${name}: ${value}`).not.toContain(key);
			let emitted = "";
			let reader = answer.body!.getReader();
			let decoder = new TextDecoder();
			try {
				for (let read = await reader.read(); !read.done; read = await reader.read()) {
					emitted += decoder.decode(read.value, { stream: true });
				}
			} catch {
				// An answer that would have emitted the key is cut short.
			}
			expect(emitted).not.toContain(key);
		}
	});

	it("never emits the key in a header Chopin adds, and refuses an answer it couldn't pass back with no-store without it", async () => {
		let world = await setup();
		let cases: Array<[key: string, status: number]> = [
			["cache-control", 502],
			["no-store", 502],
			["sk-unrelated-fixture-0123", 200],
		];
		for (let [key, status] of cases) {
			await world.connect(world.mona, "openai", { kind: "api-key", secret: key });
			let openai = (await launch(world)).grants.find(isOpenai)!;
			let proxied = aiProxy({
				credentials: world.credentials,
				fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
			});
			let url = new URL(`${openai.baseUrl}/models`);
			let answer = await proxied(
				new Request(url, {
					headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
				}),
				url,
			);
			expect(answer.status).toBe(status);
			for (let [name, value] of answer.headers) {
				expect(name).not.toContain(key.toLowerCase());
				expect(value).not.toContain(key);
			}
			expect(await answer.text()).not.toContain(key);
			if (status === 200) expect(answer.headers.get("cache-control")).toBe("no-store");
		}
	});

	it("refuses an answer whose body arrives in an encoding it can't read to take the key out of", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		let layered = brotliCompressSync(gzipSync(`{"echo":"${OPENAI_KEY}"}`));
		let upstream = provider(() =>
			new Response(layered, {
				headers: { "content-type": "application/json", "content-encoding": "gzip, br" },
			})
		);
		let proxied = aiProxy({ credentials: world.credentials, upstreams: { openai: upstream.url } });
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		let bytes = new Uint8Array(await answer.arrayBuffer());
		let unwrapped = (() => {
			try {
				return gunzipSync(brotliDecompressSync(bytes)).toString();
			} catch {
				return new TextDecoder().decode(bytes);
			}
		})();
		expect(unwrapped).not.toContain(OPENAI_KEY);
		expect(answer.status).toBe(502);
		expect(JSON.parse(new TextDecoder().decode(bytes)).error.code).toBe("upstream-encoding");
		expect(upstream.seen).toHaveLength(1);
	});

	it("passes back the provider's status code without a reason phrase that echoes the key", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		let proxied = aiProxy({
			credentials: world.credentials,
			fetch: (async () =>
				new Response('{"error":"bad key"}', {
					status: 401,
					statusText: `Invalid key ${OPENAI_KEY}`,
				})) as unknown as typeof fetch,
		});
		let url = new URL(`${openai.baseUrl}/models`);
		let answer = await proxied(
			new Request(url, {
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
			}),
			url,
		);
		expect(answer.status).toBe(401);
		expect(answer.statusText).not.toContain(OPENAI_KEY);
		expect(await answer.text()).toBe('{"error":"bad key"}');
	});

	it("sends nothing once the launch ended, its machine was revoked or its document archived while its body arrived", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let cutoffs: Array<(launch: { launchId: string; machineId: string }) => Promise<unknown>> = [
			launch => world.credentials.end(launch.launchId),
			launch => world.storage.machines.revoke(world.lease, launch.machineId, "U_mona", world.now()),
			() =>
				world.storage.channels.archive({
					id: world.channel.id,
					now: world.now(),
					lease: world.lease,
				}),
		];
		for (let cutoff of cutoffs) {
			let { machine } = await world.machines.pair({
				userId: "U_mona",
				label: "studio",
				repositories: [],
				autoRun: false,
				grant: grant("ghu_machine"),
			});
			let launched = await world.credentials.launch({
				userId: "U_mona",
				machineId: machine.id,
				channelId: world.channel.id,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
			let openai = launched.grants.find(isOpenai)!;
			let reading = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			let body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					reading.resolve();
					await release.promise;
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			}, { highWaterMark: 0 });
			let answered = world.call(openai, "/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${openai.placeholder}` },
				body,
				duplex: "half",
			} as RequestInit);
			await reading.promise;
			await cutoff({ launchId: launched.launchId, machineId: machine.id });
			release.resolve();
			let refused = await answered;
			expect(refused.status).toBe(401);
			expect(await code(refused)).toBe("launch-ended");
		}
		expect(world.upstreams.openai.seen).toEqual([]);
	});

	it("sends nothing when a cutoff completes while the final reads are pending", async () => {
		let world = await setup();
		let replacement = "sk-replacement-openai-key-0123456789";
		let connect = (secret: string) =>
			world.connect(world.mona, "openai", { kind: "api-key", secret });
		let cutoffs: Array<
			[
				cutoff: (
					launch: { launchId: string; machineId: string; channelId: string },
				) => Promise<unknown>,
				status: number,
				refusal: string,
			]
		> = [
			[launch => world.credentials.end(launch.launchId), 401, "launch-ended"],
			[
				launch =>
					world.storage.machines.revoke(world.lease, launch.machineId, "U_mona", world.now()),
				401,
				"launch-ended",
			],
			[
				launch =>
					world.storage.channels.archive({
						id: launch.channelId,
						now: world.now(),
						lease: world.lease,
					}),
				401,
				"launch-ended",
			],
			[() => connect(replacement), 409, "credential-changed"],
			[
				() => world.api("/api/ai/credentials/openai", world.mona, { method: "DELETE" }),
				403,
				"not-connected",
			],
		];
		for (let [cutoff, status, refusal] of cutoffs) {
			await connect(OPENAI_KEY);
			let { machine } = await world.machines.pair({
				userId: "U_mona",
				label: "studio",
				repositories: [],
				autoRun: false,
				grant: grant("ghu_machine"),
			});
			let channel = await world.storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Release plan",
				createdBy: "U_mona",
				now: world.now(),
			});
			let launched = await world.credentials.launch({
				userId: "U_mona",
				machineId: machine.id,
				channelId: channel.id,
				expiresAt: new Date(world.now().getTime() + 3_600_000),
			});
			let openai = launched.grants.find(isOpenai)!;
			let paused = pausedBody();
			let answered = world.call(openai, "/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${openai.placeholder}` },
				body: paused.body,
				duplex: "half",
			} as RequestInit);
			await paused.reading;
			let held = holdNextRead(world.storage.aiCredentials);
			paused.release();
			await held.reading;
			await cutoff({ launchId: launched.launchId, machineId: machine.id, channelId: channel.id });
			held.release();
			let refused = await answered;
			expect(refused.status).toBe(status);
			expect(await code(refused)).toBe(refusal);
		}
		expect(world.upstreams.openai.seen).toEqual([]);
	});

	it("refuses a send whose launch reached its deadline while its final reads were pending", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let openai = (await world.credentials.launch({
			userId: "U_mona",
			expiresAt: new Date(world.now().getTime() + 60_000),
		})).grants.find(isOpenai)!;
		let paused = pausedBody();
		let answered = world.call(openai, "/responses", {
			method: "POST",
			headers: { authorization: `Bearer ${openai.placeholder}` },
			body: paused.body,
			duplex: "half",
		} as RequestInit);
		await paused.reading;
		let placeholders = world.storage.aiPlaceholders;
		let find = placeholders.find.bind(placeholders);
		placeholders.find = async (digest, now) => {
			placeholders.find = find;
			let found = await find(digest, now);
			world.advance(60_000);
			return found;
		};
		paused.release();
		let refused = await answered;
		expect(refused.status).toBe(401);
		expect(await code(refused)).toBe("launch-ended");
		expect(world.upstreams.openai.seen).toEqual([]);
	});

	it("sends a request handed to the provider before a cutoff once, and nothing after it", async () => {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let launched = await launch(world);
		let openai = launched.grants.find(isOpenai)!;
		let answering = provider(async () => {
			await world.credentials.end(launched.launchId);
			return Response.json({ ok: true });
		});
		let proxied = aiProxy({ credentials: world.credentials, upstreams: { openai: answering.url } });
		let responses = () => {
			let url = new URL(`${openai.baseUrl}/responses`);
			return proxied(
				new Request(url, {
					method: "POST",
					headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
					body: "{}",
				}),
				url,
			);
		};
		let sentAt = world.now();
		let sent = await responses();
		expect(sent.status).toBe(200);
		expect(await sent.json()).toEqual({ ok: true });
		expect(answering.seen).toHaveLength(1);
		expect((await world.storage.aiCredentials.get("U_mona", "openai"))!.lastUsedAt).toEqual(sentAt);

		let after = await responses();
		expect(after.status).toBe(401);
		expect(answering.seen).toHaveLength(1);
	});

	it("never sends a key replaced or removed while the request's body arrived", async () => {
		let world = await setup();
		let replacement = "sk-replacement-openai-key-0123456789";
		let connect = (secret: string) =>
			world.connect(world.mona, "openai", { kind: "api-key", secret });
		let remove = () => world.api("/api/ai/credentials/openai", world.mona, { method: "DELETE" });
		await connect(OPENAI_KEY);
		let openai = (await launch(world)).grants.find(isOpenai)!;
		let changes: Array<[change: () => Promise<unknown>, status: number, refusal: string]> = [
			[() => connect(replacement), 409, "credential-changed"],
			[() => remove().then(() => connect(replacement)), 409, "credential-changed"],
			[remove, 403, "not-connected"],
		];
		for (let [change, status, refusal] of changes) {
			await connect(OPENAI_KEY);
			let paused = pausedBody();
			let answered = world.call(openai, "/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${openai.placeholder}` },
				body: paused.body,
				duplex: "half",
			} as RequestInit);
			await paused.reading;
			await change();
			paused.release();
			let refused = await answered;
			expect(refused.status).toBe(status);
			expect(await code(refused)).toBe(refusal);
		}
		expect(world.upstreams.openai.seen).toEqual([]);

		await connect(replacement);
		let answered = await world.call(openai, "/responses", {
			method: "POST",
			headers: { authorization: `Bearer ${openai.placeholder}` },
			body: "{}",
		});
		expect(answered.status).toBe(200);
		expect(world.upstreams.openai.seen.map(seen => seen.headers.authorization)).toEqual([
			`Bearer ${replacement}`,
		]);
	});
});

/** `target`'s member `name`, a method bound to it. */
function own(target: object, name: PropertyKey): unknown {
	let value: unknown = Reflect.get(target, name, target);
	return typeof value === "function" ? value.bind(target) : value;
}

/**
 * `storage` as another process serving it sees it: the same rows, but it counts in memory only the
 * cutoffs it commits itself, none here, so it never hears of one its successor commits.
 */
function seenByAnotherProcess(storage: MemoryStorage): StorageAdapter {
	let cutoffs = storage.aiPlaceholders.cutoffs();
	let placeholders = new Proxy(storage.aiPlaceholders, {
		get: (target, name) => name === "cutoffs" ? () => cutoffs : own(target, name),
	});
	let credentials = new Proxy(storage.aiCredentials, {
		get: (target, name) => name === "version" ? () => 0 : own(target, name),
	});
	return new Proxy(storage, {
		get: (target, name) =>
			name === "aiPlaceholders"
				? placeholders
				: name === "aiCredentials"
				? credentials
				: own(target, name),
	});
}

describe("a request pending while its server hands the database over", () => {
	/**
	 * A former server holding the writer lease for `ttlMs`, which serves requests as a server does,
	 * through its requests, whose drain abandons those still running, and sends through a transport
	 * that records whatever it is handed, cancelled or not; and its successor on the same store.
	 */
	async function servers(ttlMs: number) {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine"),
		});
		let held = (await world.storage.leases.acquire("chopin:writer", "former", ttlMs))!;
		let lease = new WriterLease(world.storage.leases, {
			ttlMs,
			renewMs: ttlMs,
			safetyMs: ttlMs / 4,
			retryMs: ttlMs,
		}, () => {});
		lease.hold(held);
		let former = new RunnerCredentials({
			storage: seenByAnotherProcess(world.storage),
			key: new Uint8Array(32).fill(5),
			origin: ORIGIN,
			clock: world.now,
			githubToken: async () => undefined,
			copilotToken: async () => undefined,
			writer: () => lease.holds(),
			lease: () => held,
		});
		let sent: string[] = [];
		let proxied = aiProxy({
			credentials: former,
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(new Headers(init?.headers).get("authorization") ?? "");
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		let requests = new Requests({ holdMs: 1_000, exempt: () => false });
		let openai = (await former.launch({
			userId: "U_mona",
			machineId: machine.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		let responses = (body: BodyInit) => {
			let request = new Request(`${openai.baseUrl}/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
				body,
				duplex: "half",
			} as RequestInit);
			let handled = Promise.withResolvers<Response>();
			let answered = requests.handle(request, abandoned => {
				let handling = proxied(abandonable(request, abandoned), new URL(request.url));
				handled.resolve(handling);
				return handling;
			});
			return { answered, handled: handled.promise };
		};
		/** Sends a request whose final reads the former makes, the machine read live, and holds. */
		let pending = async () => {
			let store = world.storage.aiCredentials;
			let get = store.get.bind(store);
			let reads = 0;
			let reading = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			store.get = async (userId, provider) => {
				let read = await get(userId, provider);
				// After the read made as the request is admitted comes the final one.
				if (++reads === 2) {
					store.get = get;
					reading.resolve();
					await release.promise;
				}
				return read;
			};
			let request = responses("{}");
			await reading.promise;
			return { ...request, release: () => release.resolve() };
		};
		/** The successor takes the lease, which only a release or its expiry frees, and revokes the machine. */
		let succeed = async () => {
			let successor = await world.storage.leases.acquire("chopin:writer", "successor", 30_000);
			expect(successor).toBeDefined();
			expect(await world.storage.machines.revoke(successor!, machine.id, "U_mona", world.now()))
				.toBe(true);
			await world.credentials.machineEnded(machine.id);
		};
		return { world, lease, held, requests, sent, responses, pending, succeed };
	}

	it("sends nothing from the former server after a graceful release once its successor confirms a revocation, and keeps what it sent before", async () => {
		let { world, lease, held, requests, sent, responses, pending, succeed } = await servers(30_000);
		let before = await responses("{}").answered;
		expect(before!.status).toBe(200);
		expect(await before!.json()).toEqual({ ok: true });

		let request = await pending();
		expect(await requests.finish(0)).toEqual(["POST /api/v1/ai/openai/v1/responses"]);
		await lease.stop();
		expect(await world.storage.leases.release(held)).toBe(true);
		await succeed();
		request.release();
		expect((await request.handled).status).not.toBe(200);
		expect(sent).toEqual([`Bearer ${OPENAI_KEY}`]);
	});

	it("sends nothing from a former server whose lease expired unreleased once its successor confirms a revocation, and keeps what it sent before", async () => {
		let ttlMs = 400;
		let { sent, responses, pending, succeed } = await servers(ttlMs);
		expect((await responses("{}").answered)!.status).toBe(200);

		let request = await pending();
		await Bun.sleep(ttlMs + 50);
		await succeed();
		request.release();
		let refused = (await request.answered)!;
		expect(refused.status).toBe(503);
		expect(await code(refused)).toBe("restarting");
		expect(sent).toEqual([`Bearer ${OPENAI_KEY}`]);
	});
});

describe("cutoffs on either side of a hand-over", () => {
	/**
	 * Two servers on one store once the first has handed the database over: the former, which
	 * released its writer lease, and the successor, which holds it now. Each writes under its own
	 * lease, revokes through its own machines, and sends through a transport that records what it
	 * takes; the successor counts the cutoffs it commits, and the former none of its successor's.
	 */
	async function handedOver() {
		let world = await setup();
		await world.connect(world.mona, "openai", { kind: "api-key", secret: OPENAI_KEY });
		let { machine } = await world.machines.pair({
			userId: "U_mona",
			label: "studio",
			repositories: [],
			autoRun: false,
			grant: grant("ghu_machine"),
		});
		let server = async (owner: string, storage: StorageAdapter) => {
			let held = (await world.storage.leases.acquire("chopin:writer", owner, 30_000))!;
			let lease = new WriterLease(world.storage.leases, {
				ttlMs: 30_000,
				renewMs: 30_000,
				safetyMs: 7_500,
				retryMs: 30_000,
			}, () => {});
			lease.hold(held);
			let credentials = new RunnerCredentials({
				storage,
				key: new Uint8Array(32).fill(5),
				origin: ORIGIN,
				clock: world.now,
				githubToken: async () => undefined,
				copilotToken: async () => undefined,
				writer: () => lease.holds(),
				lease: () => held,
			});
			let machines = new Machines(storage, world.now, {
				origin: ORIGIN,
				clientId: "client-id",
				key: new Uint8Array(32).fill(9),
				lease: () => held,
			});
			let sent: string[] = [];
			let proxied = aiProxy({
				credentials,
				fetch: (async (input: string | URL | Request, init?: RequestInit) => {
					if (String(input).startsWith(world.catalog.url)) return fetch(input, init);
					sent.push(new Headers(init?.headers).get("authorization") ?? "");
					return Response.json({ ok: true });
				}) as typeof fetch,
				upstreams: { catalog: world.catalog.url },
			});
			return { held, lease, credentials, machines, proxied, sent };
		};
		let former = await server("former", seenByAnotherProcess(world.storage));
		let openai = (await former.credentials.launch({
			userId: "U_mona",
			machineId: machine.id,
			expiresAt: new Date(world.now().getTime() + 3_600_000),
		})).grants.find(isOpenai)!;
		await former.lease.stop();
		expect(await world.storage.leases.release(former.held)).toBe(true);
		let successor = await server("successor", world.storage);
		let model = (on: typeof former) => {
			let url = new URL(`${openai.baseUrl}/responses`);
			return on.proxied(
				new Request(url, {
					method: "POST",
					body: "{}",
					headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
				}),
				url,
			);
		};
		let catalog = (on: typeof former) => {
			let url = new URL(`${ORIGIN}/api/v1/ai/models.dev/api.json`);
			return on.proxied(
				new Request(url, {
					headers: { authorization: `Bearer ${openai.placeholder}`, ...runner(openai) },
				}),
				url,
			);
		};
		/**
		 * Starts `request` and holds it once it has read the launch's machine for the `nth` time, the
		 * last read before it is sent or served, until released: a model request reads it as it is
		 * admitted and again at its handoff, a catalog request from a warm copy once.
		 */
		let heldAtMachineRead = async (nth: number, request: () => Promise<Response>) => {
			let machines = world.storage.machines;
			let get = machines.get.bind(machines);
			let reads = 0;
			let read = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			machines.get = async id => {
				let found = await get(id);
				if (++reads === nth) {
					machines.get = get;
					read.resolve();
					await release.promise;
				}
				return found;
			};
			let answered = request();
			await read.promise;
			return { answered, release: () => release.resolve() };
		};
		return { world, machine, former, successor, model, catalog, heldAtMachineRead };
	}

	it("refuses a revocation the former server makes once its successor holds the writer lease, so the successor's pending send follows no acknowledged revocation", async () => {
		let { world, machine, former, successor, model, heldAtMachineRead } = await handedOver();
		let pending = await heldAtMachineRead(2, () => model(successor));
		let revoked = await former.machines.revoke(machine.id, "U_mona").then(
			done => ({ done }),
			(err: unknown) => ({ err }),
		);
		expect(revoked).toMatchObject({ err: expect.any(Error) });
		expect((await world.storage.machines.get(machine.id))!.revokedAt).toBeUndefined();
		pending.release();
		expect((await pending.answered).status).toBe(200);
		expect(successor.sent).toEqual([`Bearer ${OPENAI_KEY}`]);
		expect(former.sent).toEqual([]);
	});

	it("stops the successor's own pending send when it revokes the machine", async () => {
		let { world, machine, successor, model, heldAtMachineRead } = await handedOver();
		expect((await model(successor)).status).toBe(200);
		let pending = await heldAtMachineRead(2, () => model(successor));
		expect(await successor.machines.revoke(machine.id, "U_mona")).toBe(true);
		expect((await world.storage.machines.get(machine.id))!.revokedAt).toBeDefined();
		pending.release();
		let refused = await pending.answered;
		expect(refused.status).toBe(401);
		expect(await code(refused)).toBe("launch-ended");
		expect(successor.sent).toEqual([`Bearer ${OPENAI_KEY}`]);
	});

	it("serves the catalog only from the server holding the writer lease, and stops the successor's pending answer when it revokes the machine", async () => {
		let { world, machine, former, successor, catalog, heldAtMachineRead } = await handedOver();
		let refused = await catalog(former);
		expect(refused.status).toBe(503);
		expect(await code(refused)).toBe("restarting");
		expect(world.catalog.seen).toHaveLength(0);

		expect((await catalog(successor)).status).toBe(200);
		expect(world.catalog.seen).toHaveLength(1);
		let stale = await catalog(former);
		expect(stale.status).toBe(503);

		let pending = await heldAtMachineRead(1, () => catalog(successor));
		expect(await successor.machines.revoke(machine.id, "U_mona")).toBe(true);
		pending.release();
		let ended = await pending.answered;
		expect(ended.status).toBe(401);
		expect(await code(ended)).toBe("launch-ended");
		expect(world.catalog.seen).toHaveLength(1);
	});
});
