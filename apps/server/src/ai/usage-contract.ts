import { describe, expect, it } from "bun:test";

import { AI_LAUNCH_HEADER } from "@chopin/protocol/ai-credentials";

import { contractId, openedStorage } from "../storage/contract-support";
import { unavailable } from "../storage/errors";
import { AiCredentials } from "./credentials";
import { aiProxy } from "./proxy";
import { AiUsage } from "./usage";

import type { AiModelUsage, AiUsageSummary } from "@chopin/protocol/ai-usage";
import type { StorageFactory } from "../storage/contract-support";
import type { AiTransport } from "./proxy";

/** How many requests a person's usage counts as sent, over every model. */
function sent(summary: AiUsageSummary): number {
	return summary.models.reduce((total, model) => total + model.requests, 0);
}

function now(): Date {
	return new Date();
}

/**
 * One person with an OpenAI key and a live launch, whose requests go through the proxy to a
 * transport that records each request it takes and answers it with a few tokens.
 */
async function launched(factory: StorageFactory) {
	let storage = await openedStorage(factory);
	let userId = contractId("user");
	await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now: now() });
	let lease = await storage.leases.acquire(contractId("writer"), contractId("instance"), 60_000);
	if (!lease) throw new Error("test could not acquire its writer lease");
	let held = lease;
	let credentials = new AiCredentials({
		storage,
		key: new Uint8Array(32).fill(5),
		origin: "https://chopin.test",
		clock: now,
		githubToken: async () => undefined,
		copilotToken: async () => undefined,
		fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
		lease: () => held,
	});
	let usage = new AiUsage({ storage, lease: () => held, clock: now });
	/** Each request the transport took, in the order it took them. */
	let submitted: string[] = [];
	let transport: AiTransport = (target, init, deadlines) => {
		let at = Date.now();
		if (at >= deadlines.launch) return { late: "launch" };
		submitted.push(`${init.method} ${target.pathname}`);
		return {
			sent: Promise.resolve(Response.json({ usage: { prompt_tokens: 7, completion_tokens: 3 } })),
			at,
		};
	};
	let proxied = aiProxy({ credentials, usage, transport });
	await credentials.connect(userId, "openai", {
		kind: "api-key",
		secret: "sk-mona-openai-key-0123456789",
	});
	let launch = await credentials.launch({ userId, expiresAt: new Date(Date.now() + 3_600_000) });
	let openai = launch.grants.find(grant => grant.provider === "openai")!;
	let call = () => {
		let url = new URL(`${openai.baseUrl}/chat/completions`);
		return proxied(
			new Request(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${openai.placeholder}`,
					[AI_LAUNCH_HEADER]: launch.launchToken,
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "gpt-a", messages: [] }),
			}),
			url,
		);
	};
	/** The person's usage once nothing of theirs is pending any longer. */
	let settled = async () => {
		for (let tries = 0; tries < 400; tries++) {
			let summary = await usage.summary(userId);
			if (summary.models.every(model => model.pending === 0)) return summary;
			await Bun.sleep(5);
		}
		throw new Error("a request stayed pending");
	};
	return { storage, usage, userId, submitted, call, settled };
}

/** What the transport takes for the one request sent. */
const SUBMITTED = "POST /v1/chat/completions";

const ONE_SENT: AiModelUsage[] = [{
	provider: "openai",
	model: "gpt-a",
	requests: 1,
	errors: 0,
	pending: 0,
	unknown: 0,
	tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
}];

/**
 * A person's count of sent requests against what the transport took, through the proxy and the
 * usage service, when a request fails after its record was reserved and is then sent again.
 */
export function sentRequestsContract(name: string, factory: StorageFactory) {
	describe(`${name} AI usage of requests sent again`, () => {
		it("counts nothing for a request whose final check failed after its record was reserved, and one for its retry", async () => {
			let world = await launched(factory);
			try {
				let begin = world.storage.aiUsage.begin.bind(world.storage.aiUsage);
				let find = world.storage.aiPlaceholders.find.bind(world.storage.aiPlaceholders);
				let reserved = false;
				let failing = true;
				let reached = Promise.withResolvers<void>();
				let fail = Promise.withResolvers<void>();
				world.storage.aiUsage.begin = async (lease, attempt) => {
					await begin(lease, attempt);
					reserved = true;
				};
				world.storage.aiPlaceholders.find = async (digest, at) => {
					if (!reserved || !failing) return find(digest, at);
					failing = false;
					reached.resolve();
					await fail.promise;
					throw unavailable("the database connection was lost");
				};

				let failed = world.call();
				await reached.promise;
				let reading = await world.usage.summary(world.userId);
				expect(sent(reading)).toBe(0);
				expect(reading.models).toMatchObject([{ requests: 0, pending: 1 }]);
				fail.resolve();
				await expect(failed).rejects.toThrow("the database connection was lost");
				expect(world.submitted).toEqual([]);
				expect(sent(await world.usage.summary(world.userId))).toBe(world.submitted.length);
				expect((await world.settled()).models).toEqual([]);

				let retried = await world.call();
				expect(retried.status).toBe(200);
				await retried.text();
				expect(world.submitted).toEqual([SUBMITTED]);
				let after = await world.settled();
				expect(sent(after)).toBe(world.submitted.length);
				expect(after.models).toEqual(ONE_SENT);
			} finally {
				await world.storage.close();
			}
		});

		it("counts nothing for a request whose saved record's acknowledgement was lost, and one for its retry", async () => {
			let world = await launched(factory);
			try {
				let begin = world.storage.aiUsage.begin.bind(world.storage.aiUsage);
				let lost = false;
				world.storage.aiUsage.begin = async (lease, attempt) => {
					await begin(lease, attempt);
					if (lost) return;
					lost = true;
					throw unavailable("the connection closed before the commit was acknowledged");
				};

				let refused = await world.call();
				expect(refused.status).toBe(503);
				expect(await refused.json()).toMatchObject({ error: { code: "unrecorded" } });
				expect(world.submitted).toEqual([]);
				expect(sent(await world.usage.summary(world.userId))).toBe(world.submitted.length);
				expect((await world.settled()).models).toEqual([]);

				let retried = await world.call();
				expect(retried.status).toBe(200);
				await retried.text();
				expect(world.submitted).toEqual([SUBMITTED]);
				let after = await world.settled();
				expect(sent(after)).toBe(world.submitted.length);
				expect(after.models).toEqual(ONE_SENT);
			} finally {
				await world.storage.close();
			}
		});
	});
}
