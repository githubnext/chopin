import { expect, test } from "bun:test";

import { Readiness, registerHealthRoutes } from "./health";
import { Router } from "./router";

function service(holdsLease = () => true, options: { standby?: boolean } = {}) {
	let readiness = new Readiness(holdsLease, options);
	let router = new Router();
	registerHealthRoutes(router, readiness);
	let get = async (path: string, method = "GET") => {
		let response = (await router.handle(new Request(`http://chopin.test${path}`, { method })))!;
		return { status: response.status, body: await response.text(), response };
	};
	return {
		readiness,
		live: () => get("/api/health/live"),
		ready: () => get("/api/health/ready"),
		get,
	};
}

test("readiness is false until startup recovery has finished", async () => {
	let { readiness, ready } = service();
	expect(await ready()).toMatchObject({ status: 503, body: "starting" });
	readiness.started();
	expect(await ready()).toMatchObject({ status: 200, body: "ready" });
});

test("readiness needs the writer lease as well as finished recovery", async () => {
	let held = false;
	let { readiness, ready } = service(() => held);
	readiness.started();
	expect(await ready()).toMatchObject({ status: 503, body: "starting" });
	held = true;
	expect(await ready()).toMatchObject({ status: 200, body: "ready" });
});

test("readiness is false from the moment a drain starts, and stays false", async () => {
	let { readiness, ready } = service();
	readiness.started();
	expect((await ready()).status).toBe(200);
	readiness.draining();
	expect(await ready()).toMatchObject({ status: 503, body: "draining" });
	readiness.started();
	expect(await ready()).toMatchObject({ status: 503, body: "draining" });
});

test("a drain that begins during startup keeps the process from ever being ready", async () => {
	let { readiness, ready } = service();
	readiness.draining();
	readiness.started();
	expect(await ready()).toMatchObject({ status: 503, body: "draining" });
});

test("liveness is true while the process runs, whatever readiness says", async () => {
	let { readiness, live } = service(() => false);
	expect(await live()).toMatchObject({ status: 200, body: "live" });
	readiness.started();
	readiness.draining();
	expect(await live()).toMatchObject({ status: 200, body: "live" });
});

test("both answer one word to a caller with no credentials, and are never cached", async () => {
	let { readiness, live, ready } = service();
	readiness.started();
	for (let { status, body, response } of [await live(), await ready()]) {
		expect(status).toBe(200);
		expect(body).toMatch(/^[a-z]+$/);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
	}
});

test("a probe may ask with HEAD and gets the status without a body", async () => {
	let { readiness, get } = service();
	expect(await get("/api/health/ready", "HEAD")).toMatchObject({ status: 503, body: "" });
	readiness.started();
	expect(await get("/api/health/ready", "HEAD")).toMatchObject({ status: 200, body: "" });
	expect(await get("/api/health/live", "HEAD")).toMatchObject({ status: 200, body: "" });
});

test("a process waiting for the writer lease is live as standby and never ready, until it holds the lease", async () => {
	let held = false;
	let { readiness, live, ready } = service(() => held, { standby: true });
	expect(await live()).toMatchObject({ status: 200, body: "standby" });
	expect(await ready()).toMatchObject({ status: 503, body: "standby" });
	held = true;
	readiness.acquired();
	expect(await live()).toMatchObject({ status: 200, body: "live" });
	expect(await ready()).toMatchObject({ status: 503, body: "starting" });
	readiness.started();
	expect(await ready()).toMatchObject({ status: 200, body: "ready" });
});

test("a standby never answers ready even when startup says it has finished", async () => {
	let { readiness, ready } = service(() => true, { standby: true });
	readiness.started();
	expect(await ready()).toMatchObject({ status: 503, body: "standby" });
});

test("it counts the readiness checks it refuses once a drain has begun, and no others", async () => {
	let { readiness, ready, live, get } = service();
	readiness.started();
	await ready();
	await live();
	expect(readiness.refusedWhileDraining).toBe(0);
	readiness.draining();
	await live();
	await get("/api/health/ready", "HEAD");
	await ready();
	expect(readiness.refusedWhileDraining).toBe(2);
});
