import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { AI_LAUNCH_HEADER } from "@chopin/protocol/ai-credentials";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { unavailable } from "../storage/errors";
import { MemoryStorage } from "../storage/memory/adapter";
import { AiCredentials } from "./credentials";
import { aiProxy } from "./proxy";
import { githubSignIn, registerAiRoutes } from "./routes";
import { AiUsage } from "./usage";

import type { AiProviderGrant } from "@chopin/protocol/ai-credentials";
import type { AiUsageSummary } from "@chopin/protocol/ai-usage";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant } from "../github/client";
import type { AiPlaceholder, Lease } from "../storage/model";

const ORIGIN = "https://chopin.test";
const WRITER = "chopin:writer";

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

function serve(answer: (request: Request) => Response | Promise<Response>) {
	let seen: Array<{ path: string; body: string }> = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			seen.push({ path: new URL(request.url).pathname, body: await request.clone().text() });
			return answer(request);
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

/** An AI usage recorder that also remembers the id of each request it records. */
class RecordedUsage extends AiUsage {
	readonly ids: string[] = [];
	override async begin(placeholder: AiPlaceholder, body: Uint8Array | undefined) {
		let attempt = await super.begin(placeholder, body);
		this.ids.push(attempt.id);
		return attempt;
	}
}

function sse(events: unknown[]): Response {
	let text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")
		+ "data: [DONE]\n\n";
	let bytes = new TextEncoder().encode(text);
	let middle = Math.floor(bytes.length / 2);
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(bytes.slice(0, middle));
				controller.enqueue(bytes.slice(middle));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function setup(
	answers: Array<(request: Request) => Response | Promise<Response>>,
	retryMs?: (failures: number) => number,
) {
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
	let sessions = new Sessions(storage, true, clock, { refresh: async () => grant("ghu_renewed") });
	let mona = (await sessions.issue("U_mona", grant("ghu_mona"))).cookie.split(";")[0]!;
	let hubot = (await sessions.issue("U_hubot", grant("ghu_hubot"))).cookie.split(";")[0]!;
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
		}),
		pairings: {},
		clock,
	};
	let next = 0;
	let openai = serve(request => {
		let answer = answers[next++];
		return answer ? answer(request) : Response.json({ error: "unexpected" }, { status: 500 });
	});
	let keyCheck = serve(() => Response.json({ data: [] }));
	let lease: Lease | undefined = (await storage.leases.acquire(WRITER, "first", 60_000))!;
	let held = lease;
	let credentials = new AiCredentials({
		storage,
		key: config.encryptionKey,
		origin: ORIGIN,
		clock,
		githubToken: githubSignIn(auth),
		copilotToken: async () => undefined,
		upstreams: { openai: keyCheck.url },
		lease: () => held,
	});
	let usage = new RecordedUsage({
		storage,
		lease: () => lease,
		clock,
		...(retryMs ? { retryMs } : {}),
	});
	let router = new Router();
	registerAiRoutes(router, auth, {
		credentials,
		proxy: aiProxy({
			credentials,
			usage,
			upstreams: { openai: openai.url },
			clock: () => now.getTime(),
		}),
		usage,
	});
	let launches = new Map<string, string>();
	let launch = async (userId: string, secret: string) => {
		await credentials.connect(userId, "openai", { kind: "api-key", secret });
		let launched = await credentials.launch({
			userId,
			expiresAt: new Date(now.getTime() + 3_600_000),
		});
		let openaiGrant = launched.grants.find(value => value.provider === "openai")!;
		launches.set(openaiGrant.placeholder, launched.launchToken);
		return openaiGrant;
	};
	let call = (grant: AiProviderGrant, path: string, body: unknown) =>
		router.handle(
			new Request(`${grant.baseUrl}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${grant.placeholder}`,
					[AI_LAUNCH_HEADER]: launches.get(grant.placeholder)!,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		) as Promise<Response>;
	let summary = async (cookie: string) => {
		let response = (await router.handle(
			new Request(`${ORIGIN}/api/ai/usage`, { headers: { cookie } }),
		)) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		return (await response.json()) as AiUsageSummary;
	};
	let settled = async (ids: string[]) => {
		for (let attempt = 0; attempt < 200; attempt++) {
			let found = await Promise.all(ids.map(id => storage.aiUsage.get(id)));
			if (found.every(value => value && value.outcome !== "pending")) return found;
			await Bun.sleep(5);
		}
		throw new Error("a recorded request never completed");
	};
	return {
		storage,
		openai,
		usage,
		router,
		mona,
		hubot,
		launch,
		call,
		summary,
		settled,
		lease: () => lease,
		dropLease() {
			lease = undefined;
		},
		clock,
	};
}

const SINCE = "2026-10-02T12:00:00.000Z";

describe("AI usage", () => {
	it("gives each person exactly their own totals, and a completion sent again changes nothing", async () => {
		let world = await setup([
			() =>
				Response.json({
					model: "gpt-a-2026",
					usage: {
						prompt_tokens: 120,
						completion_tokens: 30,
						prompt_tokens_details: { cached_tokens: 20 },
					},
				}),
			() =>
				Response.json({ error: { message: "Slow down", code: "rate_limit_exceeded" } }, {
					status: 429,
				}),
			() =>
				sse([
					{ choices: [{ delta: { content: "Hi" } }], usage: null },
					{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
				]),
		]);
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		let hubot = await world.launch("U_hubot", "sk-hubot-openai-key-0123456789");

		let first = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
		expect(first.status).toBe(200);
		expect((await first.json()).usage.completion_tokens).toBe(30);
		let limited = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
		expect(limited.status).toBe(429);
		await limited.text();
		let streamed = await world.call(hubot, "/chat/completions", {
			messages: [],
			model: "gpt-b",
			stream: true,
		});
		expect(streamed.status).toBe(200);
		expect(await streamed.text()).toContain("data: [DONE]");

		let [ok, refused, stream] = await world.settled(world.usage.ids);
		expect(ok).toMatchObject({
			userId: "U_mona",
			provider: "openai",
			model: "gpt-a",
			outcome: "ok",
			status: 200,
			tokens: { input: 100, output: 30, cacheRead: 20 },
		});
		expect(refused).toMatchObject({
			userId: "U_mona",
			outcome: "error",
			status: 429,
			error: "rate_limit_exceeded",
			tokens: {},
		});
		expect(stream).toMatchObject({
			userId: "U_hubot",
			model: "gpt-b",
			outcome: "ok",
			status: 200,
			tokens: { input: 9, output: 4 },
		});
		expect(ok!.launchId).not.toBe(stream!.launchId);

		let monaTotals: AiUsageSummary = {
			since: SINCE,
			models: [{
				provider: "openai",
				model: "gpt-a",
				requests: 2,
				errors: 1,
				unknown: 0,
				tokens: { input: 100, output: 30, cacheRead: 20, cacheWrite: 0 },
			}],
		};
		let hubotTotals: AiUsageSummary = {
			since: SINCE,
			models: [{
				provider: "openai",
				model: "gpt-b",
				requests: 1,
				errors: 0,
				unknown: 0,
				tokens: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0 },
			}],
		};
		expect(await world.summary(world.mona)).toEqual(monaTotals);
		expect(await world.summary(world.hubot)).toEqual(hubotTotals);

		for (let id of world.usage.ids) {
			expect(
				await world.storage.aiUsage.complete(world.lease()!, id, {
					outcome: "ok",
					status: 200,
					tokens: { input: 1_000, output: 1_000 },
					completedAt: world.clock(),
				}),
			).toBe(false);
		}
		expect(await world.summary(world.mona)).toEqual(monaTotals);
		expect(await world.summary(world.hubot)).toEqual(hubotTotals);

		let anonymous = (await world.router.handle(new Request(`${ORIGIN}/api/ai/usage`))) as Response;
		expect(anonymous.status).toBe(401);
	});

	it("leaves a request sent before a restart, whose end was never recorded, marked unknown", async () => {
		let answered = Promise.withResolvers<Response>();
		let world = await setup([() => answered.promise]);
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		let pending = world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
		while (world.openai.seen.length === 0) await Bun.sleep(5);
		let [id] = world.usage.ids;
		expect((await world.storage.aiUsage.get(id!))?.outcome).toBe("pending");

		await world.storage.leases.release(world.lease()!);
		let next = (await world.storage.leases.acquire(WRITER, "second", 60_000))!;
		let restarted = new AiUsage({ storage: world.storage, lease: () => next, clock: world.clock });
		expect(await restarted.retire()).toBe(1);

		let warned = spyOn(console, "warn").mockImplementation(() => {});
		try {
			answered.resolve(Response.json({ usage: { prompt_tokens: 5, completion_tokens: 5 } }));
			await (await pending).text();
			for (let wait = 0; wait < 100 && warned.mock.calls.length === 0; wait++) await Bun.sleep(5);
			expect(warned).toHaveBeenCalled();
		} finally {
			warned.mockRestore();
		}

		expect(await world.storage.aiUsage.get(id!)).toMatchObject({
			outcome: "unknown",
			tokens: {},
		});
		expect(await restarted.summary("U_mona")).toEqual({
			since: SINCE,
			models: [{
				provider: "openai",
				model: "gpt-a",
				requests: 1,
				errors: 0,
				unknown: 1,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}],
		});
	});

	it("writes how a request ended again after a passing storage trouble, while its lease is held", async () => {
		let waits: number[] = [];
		let world = await setup([
			() => Response.json({ usage: { prompt_tokens: 123, completion_tokens: 9 } }),
			() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
		], failures => {
			waits.push(failures);
			return 1;
		});
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		let original = world.storage.aiUsage.complete.bind(world.storage.aiUsage);
		let tries = 0;
		world.storage.aiUsage.complete = async (lease, id, result) => {
			tries++;
			if (tries <= 2) throw unavailable("the database is restarting");
			return original(lease, id, result);
		};
		let warned = spyOn(console, "warn").mockImplementation(() => {});
		try {
			let answered = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
			expect(answered.status).toBe(200);
			await answered.text();
			let [ended] = await world.settled(world.usage.ids);
			expect(ended).toMatchObject({
				outcome: "ok",
				status: 200,
				tokens: { input: 123, output: 9 },
				completedAt: world.clock(),
			});
			expect(tries).toBe(3);
			expect(waits).toEqual([1, 2]);

			tries = 0;
			world.storage.aiUsage.complete = async () => {
				tries++;
				world.dropLease();
				throw unavailable("the database is restarting");
			};
			let lost = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
			await lost.text();
			await Bun.sleep(20);
			expect(tries).toBe(1);
			expect((await world.storage.aiUsage.get(world.usage.ids[1]!))?.outcome).toBe("pending");
		} finally {
			warned.mockRestore();
		}
	});

	it("sends nothing it couldn't record first", async () => {
		let world = await setup([() => Response.json({})]);
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		world.dropLease();
		let response = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "unrecorded" } });
		expect(world.openai.seen).toEqual([]);
	});

	it("records a request the proxy refuses at the send as unsent, which no total counts", async () => {
		let world = await setup([() => Response.json({})]);
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		let original = world.storage.aiUsage.begin.bind(world.storage.aiUsage);
		world.storage.aiUsage.begin = async (lease, attempt) => {
			await original(lease, attempt);
			await world.storage.aiCredentials.delete(world.lease()!, "U_mona", "openai");
		};
		let response = await world.call(mona, "/chat/completions", { model: "gpt-a", messages: [] });
		expect(response.status).toBe(403);
		let [unsent] = await world.settled(world.usage.ids);
		expect(unsent).toMatchObject({ outcome: "unsent", error: "not-connected" });
		expect(world.openai.seen).toEqual([]);
		expect((await world.summary(world.mona)).models).toEqual([]);
	});

	it("records a stream its agent stops reading as cancelled, with the tokens read so far", async () => {
		let world = await setup([() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`event: message_start\ndata: ${
									JSON.stringify({
										type: "message_start",
										message: {
											usage: {
												input_tokens: 12,
												output_tokens: 1,
												cache_read_input_tokens: 100,
												cache_creation_input_tokens: 7,
											},
										},
									})
								}\n\n`,
							),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)]);
		let mona = await world.launch("U_mona", "sk-mona-openai-key-0123456789");
		let response = await world.call(mona, "/chat/completions", { model: "gpt-a", stream: true });
		let reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		let [cancelled] = await world.settled(world.usage.ids);
		expect(cancelled).toMatchObject({
			outcome: "error",
			status: 200,
			error: "cancelled",
			tokens: { input: 12, output: 1, cacheRead: 100, cacheWrite: 7 },
		});
	});
});
