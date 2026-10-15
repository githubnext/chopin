import { expect, test } from "bun:test";

import { registerMachinesPath } from "./machines-path";
import { Router } from "./router";

function router() {
	let routes = new Router();
	registerMachinesPath(routes);
	return (path: string, method = "GET") =>
		routes.handle(new Request(`http://chopin.test${path}`, { method }));
}

test("/connect, as pairing links printed before /machines did, redirects there with its query", async () => {
	let handle = router();
	for (
		let [path, location] of [
			["/connect", "/machines"],
			["/connect/", "/machines"],
			["/connect?pairing=0193f0a4-pairing", "/machines?pairing=0193f0a4-pairing"],
			["/connect?server", "/machines?server"],
			["/connect?machine=M%201", "/machines?machine=M%201"],
		]
	) {
		let response = (await handle(path))!;
		expect([path, response.status, response.headers.get("location")]).toEqual([
			path,
			308,
			location,
		]);
	}
	let head = (await handle("/connect?add", "HEAD"))!;
	expect([head.status, head.headers.get("location")]).toEqual([308, "/machines?add"]);
});

test("/machines itself is left to the web client", async () => {
	let handle = router();
	expect(await handle("/machines")).toBeUndefined();
	expect(await handle("/machines?pairing=0193f0a4-pairing")).toBeUndefined();
});
