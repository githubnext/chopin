import { afterEach, expect, test } from "bun:test";
import { startAiRelay } from "./ai-relay";
import type { AiRelay } from "./ai-relay";

const LAUNCH = "chopin_launch_relayed";

let stops: Array<() => unknown> = [];
afterEach(async () => {
	for (let stop of stops.splice(0)) await stop();
});

type Seen = { path: string; headers: Record<string, string>; body: string };

/** Chopin's credential proxy as a relay meets it: it records each request it is sent. */
function chopin(answer: (path: string) => Response = () => Response.json({ ok: true })) {
	let seen: Seen[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let url = new URL(request.url);
			let path = `${url.pathname}${url.search}`;
			seen.push({ path, headers: Object.fromEntries(request.headers), body: await request.text() });
			return answer(path);
		},
	});
	stops.push(() => server.stop(true));
	return { origin: `http://127.0.0.1:${server.port}`, seen };
}

function relay(): AiRelay {
	let started = startAiRelay();
	stops.push(() => started.close());
	return started;
}

function grants(origin: string) {
	return [
		{
			provider: "openai" as const,
			baseUrl: `${origin}/api/v1/ai/openai/v1`,
			placeholder: "chopin_ai_openai",
			keyVariable: "OPENAI_API_KEY",
		},
		{
			provider: "anthropic" as const,
			baseUrl: `${origin}/api/v1/ai/anthropic`,
			placeholder: "chopin_ai_anthropic",
			keyVariable: "ANTHROPIC_API_KEY",
		},
	];
}

test("relays a provider's request to its base URL on Chopin, adding the launch's credential the agent never had", async () => {
	let upstream = chopin(() => new Response("data: hi\n\n", { headers: { "x-request-id": "r1" } }));
	let relayed = relay().open(LAUNCH, grants(upstream.origin));
	let answer = await fetch(`${relayed.baseUrls.openai}/chat/completions?stream=1`, {
		method: "POST",
		headers: {
			authorization: "Bearer chopin_ai_openai",
			"content-type": "application/json",
			// An agent that tries to name a launch is not believed.
			"x-chopin-launch": "chopin_launch_forged",
		},
		body: JSON.stringify({ model: "m" }),
	});
	expect(answer.status).toBe(200);
	expect(answer.headers.get("x-request-id")).toBe("r1");
	expect(await answer.text()).toBe("data: hi\n\n");
	expect(upstream.seen).toHaveLength(1);
	let [sent] = upstream.seen;
	expect(sent!.path).toBe("/api/v1/ai/openai/v1/chat/completions?stream=1");
	expect(sent!.headers.authorization).toBe("Bearer chopin_ai_openai");
	expect(sent!.headers["x-chopin-launch"]).toBe(LAUNCH);
	expect(sent!.body).toBe(JSON.stringify({ model: "m" }));
	expect(relayed.baseUrls.anthropic).toStartWith("http://127.0.0.1:");
	expect(relayed.baseUrls.anthropic).not.toContain(LAUNCH);
});

test("asks for the models.dev catalog with one of the launch's stand-ins", async () => {
	let upstream = chopin();
	let relayed = relay().open(LAUNCH, grants(upstream.origin));
	expect((await fetch(`${relayed.catalogUrl}/api.json`)).status).toBe(200);
	expect(upstream.seen[0]).toMatchObject({
		path: "/api/v1/ai/models.dev/api.json",
		headers: { authorization: "Bearer chopin_ai_openai", "x-chopin-launch": LAUNCH },
	});
});

test("reaches no provider it was not given, no launch it does not hold, and nothing once closed", async () => {
	let upstream = chopin();
	let started = relay();
	let relayed = started.open(LAUNCH, grants(upstream.origin).slice(0, 1));
	let base = relayed.baseUrls.openai!;
	let other = base.replace(/\/openai$/, "/github-copilot");
	expect((await fetch(`${other}/models`)).status).toBe(404);
	let unknown = base.replace(/\/[^/]+\/openai$/, "/not-a-launch/openai");
	expect((await fetch(`${unknown}/models`)).status).toBe(404);
	expect((await fetch(`${base}x/models`)).status).toBe(404);
	relayed.close();
	expect((await fetch(`${base}/models`)).status).toBe(404);
	expect(upstream.seen).toEqual([]);
});

test("says once when Chopin answers that the launch has ended", async () => {
	let upstream = chopin(() => Response.json({ code: "launch-ended" }, { status: 401 }));
	let ended = 0;
	let relayed = relay().open(LAUNCH, grants(upstream.origin), () => ended++);
	for (let attempt = 0; attempt < 2; attempt++) {
		let answer = await fetch(`${relayed.baseUrls.anthropic}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(answer.status).toBe(401);
		expect(await answer.json()).toEqual({ code: "launch-ended" });
	}
	expect(ended).toBe(1);
});
