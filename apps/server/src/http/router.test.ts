import { describe, expect, it } from "bun:test";

import { Router } from "./router";

describe("HTTP routing", () => {
	it("dispatches an exact method and path", async () => {
		let router = new Router();
		router.on("GET", "/api/session", (_request, url) => Response.json({ query: url.search }));

		let response = await router.handle(new Request("https://chopin.test/api/session?from=room"));
		expect(response!.status).toBe(200);
		expect(await response!.json()).toEqual({ query: "?from=room" });
	});

	it("does not send a known API path with the wrong method to the SPA", async () => {
		let router = new Router();
		router.on("GET", "/api/session", () => new Response("session"));

		let response = await router.handle(
			new Request("https://chopin.test/api/session", {
				method: "POST",
			}),
		);
		expect(response!.status).toBe(405);
		expect(response!.headers.get("allow")).toBe("GET");
		expect(response!.headers.get("cache-control")).toBe("no-store");
	});

	it("owns unknown API and authentication paths", async () => {
		let router = new Router();
		expect((await router.handle(new Request("https://chopin.test/api/unknown")))!.status).toBe(404);
		expect((await router.handle(new Request("https://chopin.test/auth/unknown")))!.status).toBe(
			404,
		);
		expect(await router.handle(new Request("https://chopin.test/missing"))).toBeUndefined();
	});

	it("matches and decodes complete path segments", async () => {
		let router = new Router();
		router.on(
			"GET",
			"/api/repositories/:owner/:repository/channels",
			(_request, _url, params) => Response.json(params),
		);
		let response = await router.handle(
			new Request(
				"https://chopin.test/api/repositories/github%20next/chopin/channels",
			),
		);
		expect(await response!.json()).toEqual({ owner: "github next", repository: "chopin" });
		let wrongMethod = await router.handle(
			new Request(
				"https://chopin.test/api/repositories/github/chopin/channels",
				{ method: "POST" },
			),
		);
		expect(wrongMethod!.status).toBe(405);
		expect(wrongMethod!.headers.get("allow")).toBe("GET");
		expect(
			(await router.handle(
				new Request(
					"https://chopin.test/api/repositories/github%2Fnext/chopin/channels",
				),
			))!.status,
		).toBe(404);
	});
});
