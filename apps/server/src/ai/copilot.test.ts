import { afterEach, describe, expect, it } from "bun:test";

import { copilotEntitlement } from "./copilot";

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

function github(status: number) {
	let asked: Array<{ path: string; authorization: string | null }> = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			asked.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
			});
			return Response.json({ token: "tid=1;exp=1", expires_at: 1 }, { status });
		},
	});
	servers.push(server);
	return { api: `http://127.0.0.1:${server.port}`, asked };
}

describe("Copilot entitlement", () => {
	it("is a Copilot token GitHub gives for the sign-in, and none when GitHub refuses one", async () => {
		let given = github(200);
		expect(await copilotEntitlement({ api: given.api })("ghu_person")).toBe(true);
		expect(given.asked).toEqual([
			{ path: "/copilot_internal/v2/token", authorization: "token ghu_person" },
		]);
		for (let status of [401, 403, 404]) {
			expect(await copilotEntitlement({ api: github(status).api })("ghu_person")).toBe(false);
		}
	});

	it("can't be told from an answer that says nothing about the account", async () => {
		expect(copilotEntitlement({ api: github(500).api })("ghu_person")).rejects.toThrow("500");
		expect(copilotEntitlement({ api: "http://127.0.0.1:9" })("ghu_person")).rejects.toThrow();
	});
});
