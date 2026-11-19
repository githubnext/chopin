/**
 * A run's relay hears its launch end from Chopin's own proxy, whatever ended it, and only then:
 * each cutoff refuses the agent's requests, sends its provider nothing, and tells the run once.
 */
import { afterEach, expect, test } from "bun:test";

import { AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { startAiRelay } from "../../../connector/src/ai-relay";
import { Router } from "../http/router";
import { testLease } from "../storage/contract-support";
import { machine } from "../storage/machine-contract";
import { MemoryStorage } from "../storage/memory/adapter";
import { AiCredentials } from "./credentials";
import { aiProxy } from "./proxy";

const KEY = "sk-mona-openai-key-0123456789";

let stops: Array<() => unknown> = [];
afterEach(async () => {
	for (let stop of stops.splice(0)) await stop();
});

/** Chopin with mona's key, her document and machine, its proxy served, and a run's relay. */
async function chopin() {
	let now = { ms: Date.now() };
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now: new Date() });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: "U_mona",
		now: new Date(),
	});
	let paired = machine("U_mona");
	await storage.machines.create(paired);
	let lease = await testLease(storage);
	let provider = { calls: 0, answer: "ok" as "ok" | "refused" };
	let openai = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [] });
			provider.calls++;
			return provider.answer === "refused"
				? Response.json({ error: { code: "model_not_found", message: "no" } }, { status: 401 })
				: Response.json({ choices: [] });
		},
	});
	stops.push(() => openai.stop(true));
	let router = new Router();
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => await router.handle(request) as Response,
	});
	stops.push(() => server.stop(true));
	let origin = `http://127.0.0.1:${server.port}`;
	let upstream = `http://127.0.0.1:${openai.port}`;
	let credentials = new AiCredentials({
		storage,
		lease: () => lease,
		key: new Uint8Array(32).fill(4),
		origin,
		clock: () => new Date(now.ms),
		githubToken: async () => undefined,
		copilotToken: async () => undefined,
		upstreams: { openai: upstream },
	});
	router.prefix(`${AI_PROXY_PATH}/`, aiProxy({ credentials, upstreams: { openai: upstream } }));
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: KEY });
	let launched = await credentials.launch({
		userId: "U_mona",
		machineId: paired.id,
		channelId: channel.id,
		expiresAt: new Date(now.ms + 60 * 60_000),
		owner: "run:run-1",
	});
	let relay = startAiRelay();
	stops.push(() => relay.close());
	let ended = 0;
	let relayed = relay.open(launched.launchToken, launched.grants, () => ended++);
	let [grant] = launched.grants;
	let read = () =>
		fetch(`${relayed.baseUrls.openai}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${grant!.placeholder}` },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
	return {
		storage,
		channel,
		machine: paired,
		lease,
		credentials,
		launched,
		provider,
		now,
		read,
		ended: () => ended,
	};
}

test("each cutoff refuses the agent twice, sends the provider nothing, and tells the run once", async () => {
	let cutoffs: Record<string, (world: Awaited<ReturnType<typeof chopin>>) => Promise<unknown>> = {
		archive: ({ storage, channel, lease }) =>
			storage.channels.archive({ id: channel.id, now: new Date(), lease }),
		end: ({ credentials, launched }) => credentials.end(launched.launchId),
		expiry: async ({ now }) => void (now.ms += 2 * 60 * 60_000),
		revocation: ({ storage, machine: paired, lease }) =>
			storage.machines.revoke(lease, paired.id, "U_mona", new Date()),
	};
	for (let [name, cut] of Object.entries(cutoffs)) {
		let world = await chopin();
		expect((await world.read()).status, name).toBe(200);
		expect(world.provider.calls, name).toBe(1);
		await cut(world);
		for (let attempt = 0; attempt < 2; attempt++) {
			let answer = await world.read();
			expect(answer.status, name).toBe(401);
			await answer.body?.cancel();
		}
		expect(world.provider.calls, name).toBe(1);
		expect(world.ended(), name).toBe(1);
	}
});

test("a provider's own refusal on a live launch tells the run nothing", async () => {
	let world = await chopin();
	world.provider.answer = "refused";
	for (let attempt = 0; attempt < 2; attempt++) {
		let answer = await world.read();
		expect(answer.status).toBe(401);
		expect(await answer.json()).toMatchObject({ error: { code: "model_not_found" } });
	}
	expect(world.provider.calls).toBe(2);
	expect(world.ended()).toBe(0);
});
