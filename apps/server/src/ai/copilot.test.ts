import { afterEach, describe, expect, it } from "bun:test";

import { copilotTokenExchange } from "./copilot";

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

function github(
	status: number,
	body: unknown = { token: "tid=1;exp=2", expires_at: 2_000 },
	headers: Record<string, string> = {},
) {
	let asked: Array<{ path: string; authorization: string | null }> = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			asked.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
			});
			return Response.json(body, { status, headers });
		},
	});
	servers.push(server);
	return { api: `http://127.0.0.1:${server.port}`, asked };
}

describe("Copilot token exchange", () => {
	it("is the Copilot token GitHub gives for a GitHub token, and none when GitHub refuses one", async () => {
		let given = github(200);
		expect(await copilotTokenExchange({ api: given.api })("ghu_person")).toEqual({
			token: "tid=1;exp=2",
			expiresAt: 2_000_000,
		});
		expect(given.asked).toEqual([
			{ path: "/copilot_internal/v2/token", authorization: "token ghu_person" },
		]);
		for (let status of [401, 403, 404]) {
			expect(await copilotTokenExchange({ api: github(status).api })("ghu_person"))
				.toBeUndefined();
		}
	});

	it("keeps the account's own Copilot model host only when it is one of Copilot's", async () => {
		let exchange = (api: string) =>
			copilotTokenExchange({
				api: github(200, { token: "tid=1", expires_at: 1, endpoints: { api } }).api,
			})("ghu_person");
		expect(await exchange("https://api.business.githubcopilot.com/")).toMatchObject({
			api: "https://api.business.githubcopilot.com",
		});
		for (let other of ["https://elsewhere.test", "http://api.githubcopilot.com"]) {
			expect(await exchange(other)).not.toHaveProperty("api");
		}
		expect(await exchange("https://api.githubcopilot.com.elsewhere.test")).not.toHaveProperty(
			"api",
		);
	});

	it("can't be told from an answer that says nothing about the account", async () => {
		expect(copilotTokenExchange({ api: github(500).api })("ghu_person")).rejects.toThrow("500");
		expect(copilotTokenExchange({ api: github(200, { message: "ok" }).api })("ghu_person"))
			.rejects.toThrow("without a token");
		expect(copilotTokenExchange({ api: "http://127.0.0.1:9" })("ghu_person")).rejects.toThrow();
	});

	it("can't be told from a refusal GitHub gives for its rate limit", async () => {
		let limited = { message: "API rate limit exceeded" };
		for (
			let [status, headers] of [
				[403, { "retry-after": "60" }],
				[403, { "x-ratelimit-remaining": "0" }],
				[429, {}],
			] as Array<[number, Record<string, string>]>
		) {
			let exchange = copilotTokenExchange({ api: github(status, limited, headers).api });
			await expect(exchange("ghu_person")).rejects.toThrow(String(status));
		}
		let refused = github(403, { message: "Resource not accessible" }, {
			"x-ratelimit-remaining": "4999",
		});
		expect(await copilotTokenExchange({ api: refused.api })("ghu_person")).toBeUndefined();
	});
});
