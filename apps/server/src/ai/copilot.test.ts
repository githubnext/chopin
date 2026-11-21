import { afterEach, describe, expect, it } from "bun:test";

import {
	COPILOT_RAW_TOKEN_HEADERS,
	copilotModels,
	copilotTokenExchange,
	CopilotTokenRefused,
} from "./copilot";

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers) server.stop(true);
	servers = [];
});

type Asked = {
	path: string;
	authorization: string | null;
	integration: string | null;
	version?: string | null;
};

/**
 * A server that answers every request with `status` and `body`: JSON, or a string as the plain
 * text GitHub and Copilot send some refusals in.
 */
function serve(status: number, body: unknown, headers: Record<string, string> = {}) {
	let asked: Asked[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			asked.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				integration: request.headers.get("copilot-integration-id"),
				...(request.headers.has("x-github-api-version")
					? { version: request.headers.get("x-github-api-version") }
					: {}),
			});
			return typeof body === "string"
				? new Response(body, {
					status,
					headers: { "content-type": "text/plain; charset=utf-8", ...headers },
				})
				: Response.json(body, { status, headers });
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, asked };
}

/** GitHub's API, which exchanges a GitHub token for a Copilot token. */
function github(
	status: number,
	body: unknown = { token: "tid=1;exp=2", expires_at: 2_000 },
	headers: Record<string, string> = {},
) {
	let { url, asked } = serve(status, body, headers);
	return { api: url, asked };
}

/** Copilot's model API, whose model list answers whether it takes a GitHub token itself. */
function copilot(status: number, body: unknown = { data: [{ id: "gpt-5" }] }) {
	let { url, asked } = serve(status, body);
	return { copilotApi: url, asked };
}

/** GitHub's refusal for an account with no Copilot seat, named by its `notification_id`. */
function noSeat(notificationId: string) {
	return {
		can_signup_for_limited: true,
		message: "You do not have access to GitHub Copilot.",
		error_details: {
			notification_id: notificationId,
			message: "No access to GitHub Copilot found.",
			title: "Account unavailable",
			url: "https://github.com/features/copilot",
		},
	};
}

/**
 * GitHub's answers when it won't exchange a token at all, for a person with a seat: a GitHub App's
 * user token or another app's OAuth token (the plain-text 403 page), and a personal access token
 * (404), as observed for each.
 */
const NOT_EXCHANGED =
	"403 Forbidden. For more on scraping GitHub and how it may affect your rights, "
	+ "please review our Terms of Service (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).\n";
const NOT_EXCHANGED_ANSWERS: Array<[number, unknown]> = [
	[403, NOT_EXCHANGED],
	[404, { message: "Not Found" }],
	[401, { message: "Bad credentials" }],
	[403, { message: "Resource not accessible by integration" }],
	// Refused for the account, but not for want of a seat.
	[403, noSeat("feature_flag_blocked")],
];

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

async function failure(answer: Promise<unknown>): Promise<Error> {
	let failed = await answer.then(() => undefined, (err: unknown) => err);
	expect(failed).toBeInstanceOf(Error);
	return failed as Error;
}

describe("Copilot token exchange", () => {
	it("is the Copilot token GitHub gives for a GitHub token, and asks Copilot nothing", async () => {
		let given = github(200);
		let model = copilot(200);
		expect(
			await copilotTokenExchange({ api: given.api, copilotApi: model.copilotApi })("ghu_person"),
		).toEqual({ token: "tid=1;exp=2", expiresAt: 2_000_000 });
		expect(given.asked).toEqual([
			{
				path: "/copilot_internal/v2/token",
				authorization: "token ghu_person",
				integration: null,
				version: "2022-11-28",
			},
		]);
		expect(model.asked).toEqual([]);
	});

	it("is none only when GitHub says the account has no Copilot subscription", async () => {
		for (let id of ["no_copilot_access", "not_signed_up", "subscription_ended"]) {
			let model = copilot(200);
			let exchange = copilotTokenExchange({
				api: github(403, noSeat(id)).api,
				copilotApi: model.copilotApi,
			});
			expect(await exchange("ghu_person")).toBeUndefined();
			expect(model.asked).toEqual([]);
		}
	});

	it("is the GitHub token itself, for Copilot's model API, when GitHub won't exchange it and Copilot takes it", async () => {
		for (let [status, body] of NOT_EXCHANGED_ANSWERS) {
			let model = copilot(200);
			let exchange = copilotTokenExchange({
				api: github(status, body).api,
				copilotApi: model.copilotApi,
				clock: () => NOW,
			});
			expect(await exchange("ghu_person")).toEqual({
				token: "ghu_person",
				expiresAt: NOW + 30 * 60_000,
				raw: true,
				models: { list: { data: [{ id: "gpt-5" }] }, baseUrl: model.copilotApi },
			});
			expect(model.asked).toEqual([{
				path: "/models",
				authorization: "Bearer ghu_person",
				integration: "copilot-developer-cli",
				version: "2026-06-01",
			}]);
		}
		expect(COPILOT_RAW_TOKEN_HEADERS).toEqual({
			"copilot-integration-id": "copilot-developer-cli",
		});
	});

	it("keeps no model list that can't be read or carries the token, and the access stands", async () => {
		for (let body of ["not json", { data: [{ id: "gpt-5", name: "for ghu_person" }] }]) {
			let exchange = copilotTokenExchange({
				api: github(403, NOT_EXCHANGED).api,
				copilotApi: copilot(200, body).copilotApi,
				clock: () => NOW,
			});
			expect(await exchange("ghu_person")).toEqual({
				token: "ghu_person",
				expiresAt: NOW + 30 * 60_000,
				raw: true,
			});
		}
	});

	it("can't be told, and is never none, when neither GitHub nor Copilot takes the token", async () => {
		for (let [status, body] of NOT_EXCHANGED_ANSWERS) {
			for (
				let [refusal, said] of [
					[401, "unauthorized: token authentication failed"],
					[403, { error: { message: "Forbidden" } }],
					[500, "upstream failure"],
				] as Array<[number, unknown]>
			) {
				let exchange = copilotTokenExchange({
					api: github(status, body).api,
					copilotApi: copilot(refusal, said).copilotApi,
				});
				let failed = await failure(exchange("ghu_person"));
				expect(failed.message).toContain(String(refusal));
				expect(failed.message).not.toContain("ghu_person");
				// Only Copilot refusing the token says this token reaches no Copilot.
				expect(failed instanceof CopilotTokenRefused).toBe(refusal !== 500);
			}
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
		let unreachable = copilot(503, "unavailable").copilotApi;
		expect(
			(await failure(
				copilotTokenExchange({ api: github(500).api, copilotApi: unreachable })("ghu_person"),
			)).message,
		).toContain("500");
		expect(
			(await failure(
				copilotTokenExchange({ api: github(200, { message: "ok" }).api })("ghu_person"),
			)).message,
		).toContain("without a token");
		await failure(
			copilotTokenExchange({ api: "http://127.0.0.1:9", copilotApi: unreachable })("ghu_person"),
		);
		// GitHub failing to answer says nothing of the token, whatever Copilot's model API says.
		let failing = copilotTokenExchange({
			api: github(500).api,
			copilotApi: copilot(401, "unauthorized: token authentication failed").copilotApi,
		});
		expect(await failure(failing("ghu_person"))).not.toBeInstanceOf(CopilotTokenRefused);
	});

	it("can't be told from a refusal GitHub gives for its rate limit, and asks Copilot nothing then", async () => {
		let limited = { message: "API rate limit exceeded" };
		for (
			let [status, headers] of [
				[403, { "retry-after": "60" }],
				[403, { "x-ratelimit-remaining": "0" }],
				[429, {}],
			] as Array<[number, Record<string, string>]>
		) {
			let model = copilot(200);
			let exchange = copilotTokenExchange({
				api: github(status, limited, headers).api,
				copilotApi: model.copilotApi,
			});
			let failed = await failure(exchange("ghu_person"));
			expect(failed.message).toContain(String(status));
			expect(failed).not.toBeInstanceOf(CopilotTokenRefused);
			expect(model.asked).toEqual([]);
		}
		let refused = github(403, noSeat("no_copilot_access"), {
			"x-ratelimit-remaining": "4999",
		});
		expect(await copilotTokenExchange({ api: refused.api })("ghu_person")).toBeUndefined();
	});
});

describe("an account's Copilot model list", () => {
	it("is read from the account's own Copilot host with the Copilot token, as Atomic reads it", async () => {
		let host = copilot(200, { data: [{ id: "gpt-6" }] });
		let other = copilot(200);
		let read = await copilotModels(
			{ token: "tid=1;exp=2", expiresAt: NOW + 60_000, api: host.copilotApi },
			{ copilotApi: other.copilotApi, clock: () => NOW },
		);
		expect(read).toEqual({ list: { data: [{ id: "gpt-6" }] }, baseUrl: host.copilotApi });
		expect(host.asked).toEqual([{
			path: "/models",
			authorization: "Bearer tid=1;exp=2",
			integration: "vscode-chat",
			version: "2026-06-01",
		}]);
		expect(other.asked).toEqual([]);
	});

	it("is the list a GitHub token's answer kept, asking nothing, else read from Copilot's model API alone", async () => {
		let model = copilot(200, { data: [{ id: "gpt-6" }] });
		let kept = { list: { data: [] }, baseUrl: "https://api.githubcopilot.com" };
		expect(
			await copilotModels(
				{ token: "ghu_person", expiresAt: NOW + 60_000, raw: true, models: kept },
				{ copilotApi: model.copilotApi, clock: () => NOW },
			),
		).toBe(kept);
		expect(model.asked).toEqual([]);
		expect(
			await copilotModels(
				{ token: "ghu_person", expiresAt: NOW + 60_000, raw: true, api: "https://elsewhere.test" },
				{ copilotApi: model.copilotApi, clock: () => NOW },
			),
		).toEqual({ list: { data: [{ id: "gpt-6" }] }, baseUrl: model.copilotApi });
		expect(model.asked).toEqual([{
			path: "/models",
			authorization: "Bearer ghu_person",
			integration: "copilot-developer-cli",
			version: "2026-06-01",
		}]);
	});

	it("is nothing, and sends nothing, once the token has expired, and nothing Copilot refuses or that carries the token", async () => {
		let model = copilot(200);
		let token = { token: "tid=1;exp=2", expiresAt: NOW, api: model.copilotApi };
		expect(await copilotModels(token, { clock: () => NOW })).toBeUndefined();
		expect(model.asked).toEqual([]);
		for (
			let [status, body] of [[401, "unauthorized"], [200, {
				data: [{ id: "tid=1;exp=2" }],
			}]] as Array<
				[number, unknown]
			>
		) {
			let refusing = copilot(status, body);
			expect(
				await copilotModels(
					{ token: "tid=1;exp=2", expiresAt: NOW + 1, api: refusing.copilotApi },
					{ clock: () => NOW },
				),
			).toBeUndefined();
		}
	});
});
