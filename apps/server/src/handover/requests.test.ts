import { expect, test } from "bun:test";

import { Requests } from "./requests";

function request(path: string, method = "GET", signal?: AbortSignal): Request {
	return new Request(`http://chopin.test${path}`, { method, signal });
}

function requests(holdMs = 1_000) {
	return new Requests({
		holdMs,
		exempt: (_request, url) =>
			url.pathname.startsWith("/assets/") || url.pathname.startsWith("/api/health"),
	});
}

const OK = () => new Response("ok");

test("a process that is not holding answers every request at once", async () => {
	let gate = requests();
	expect(await (await gate.handle(request("/api/session"), OK))!.text()).toBe("ok");
});

test("while holding it answers a file at once, and holds anything else until it is released", async () => {
	let gate = requests();
	gate.hold();
	expect(await (await gate.handle(request("/assets/app-12345678.js"), OK))!.text()).toBe("ok");
	let held = gate.handle(request("/api/session"), OK);
	let answered = false;
	void held.then(() => answered = true);
	await Bun.sleep(30);
	expect(answered).toBe(false);
	expect(gate.running).toBe(0);
	let stats = gate.release();
	expect(await (await held)!.text()).toBe("ok");
	expect(stats).toMatchObject({ held: 1, expired: 0 });
});

test("a request held past the bound is answered 503 with Retry-After, never 4xx", async () => {
	let gate = requests(40);
	gate.hold();
	let ran = false;
	let response = (await gate.handle(request("/api/session", "POST"), () => {
		ran = true;
		return new Response("late");
	}))!;
	expect([response.status, response.headers.get("retry-after")]).toEqual([503, "1"]);
	expect(ran).toBe(false);
	expect(gate.release()).toMatchObject({ held: 1, expired: 1 });
});

test("a held request whose client goes away stops being held", async () => {
	let gate = requests(5_000);
	gate.hold();
	let controller = new AbortController();
	let held = gate.handle(request("/api/session", "GET", controller.signal), OK);
	controller.abort();
	let response = await Promise.race([held, Bun.sleep(500).then(() => "still held" as const)]);
	expect(response).not.toBe("still held");
	expect(gate.release()).toMatchObject({ held: 1, expired: 0 });
});

test("a request upgrade is held the same way, and goes on to upgrade once released", async () => {
	let gate = requests();
	gate.hold();
	let upgraded = false;
	let held = gate.handle(request("/ws"), () => {
		upgraded = true;
		return undefined;
	});
	await Bun.sleep(20);
	expect(upgraded).toBe(false);
	gate.release();
	expect(await held).toBeUndefined();
	expect(upgraded).toBe(true);
});

test("once closing, every answer asks the client to close its connection", async () => {
	let gate = requests();
	expect((await gate.handle(request("/a"), OK))!.headers.get("connection")).toBeNull();
	gate.close();
	expect((await gate.handle(request("/a"), OK))!.headers.get("connection")).toBe("close");
	expect(
		(await gate.handle(request("/b"), () => new Response(null, { status: 204 })))!.headers.get(
			"connection",
		),
	)
		.toBe("close");
	// An answer whose headers cannot be changed is copied rather than left without the header.
	let immutable = Response.error();
	let copied = (await gate.handle(request("/c"), () => immutable))!;
	expect(copied.headers.get("connection")).toBe("close");
	expect(await gate.handle(request("/ws"), () => undefined)).toBeUndefined();
});

test("it waits for requests running now, and names those still running when the bound passes", async () => {
	let gate = requests();
	let quick = Promise.withResolvers<Response>();
	let slow = Promise.withResolvers<Response>();
	let first = gate.handle(request("/quick"), () => quick.promise);
	void gate.handle(request("/poll", "POST"), () => slow.promise);
	expect(gate.running).toBe(2);
	setTimeout(() => quick.resolve(new Response("done")), 20);
	expect(await gate.finish(60)).toEqual(["POST /poll"]);
	await first;
	slow.resolve(new Response("late"));
	await Bun.sleep(5);
	expect(await gate.finish(60)).toEqual([]);
});

test("it finishes as soon as the last request does, not at the bound", async () => {
	let gate = requests();
	let work = Promise.withResolvers<Response>();
	void gate.handle(request("/work"), () => work.promise);
	setTimeout(() => work.resolve(new Response("done")), 20);
	let started = performance.now();
	expect(await gate.finish(5_000)).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});

test("a request still running at the bound is abandoned: its answer is never sent, its signal aborts, and it no longer counts as running", async () => {
	let gate = requests();
	let work = Promise.withResolvers<Response>();
	let signal: AbortSignal | undefined;
	let answer = gate.handle(request("/poll", "POST"), abandoned => {
		signal = abandoned;
		return work.promise;
	});
	expect(await gate.finish(20)).toEqual(["POST /poll"]);
	expect(signal?.aborted).toBe(true);
	let sent = await answer;
	// What Bun sends for it is nothing: its body fails before a byte is written.
	await expect(sent!.text()).rejects.toBeUndefined();
	expect(gate.running).toBe(0);
	let cancelled = false;
	work.resolve(
		new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
		),
	);
	await Bun.sleep(10);
	expect(cancelled).toBe(true);
});

test("once the requests were finished, a request that arrives is not answered or run", async () => {
	let gate = requests();
	expect(await gate.finish(20)).toEqual([]);
	let ran = false;
	let late = await gate.handle(request("/api/session"), () => {
		ran = true;
		return new Response("late");
	});
	await expect(late!.text()).rejects.toBeUndefined();
	expect(ran).toBe(false);
});

test("a request that finishes inside the bound is answered, not cut short", async () => {
	let gate = requests();
	let done = gate.handle(request("/quick"), () => new Response("done"));
	expect(await gate.finish(500)).toEqual([]);
	expect(await (await done)!.text()).toBe("done");
});
