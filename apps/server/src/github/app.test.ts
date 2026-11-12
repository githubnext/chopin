import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";

import { GitHubAppClient } from "./app";
import { GitHubError } from "./client";

const NOW = Date.parse("2026-11-12T12:00:00Z");
let { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

type Call = { method: string; path: string; bearer: string; body?: unknown };

/** A GitHub API that answers each `METHOD /path` from `answers`, and 404 otherwise. */
function github(answers: Record<string, [number, unknown?]>) {
	let calls: Call[] = [];
	let fetch = async (input: string | URL | Request, init?: RequestInit) => {
		let url = new URL(String(input));
		let method = init?.method ?? "GET";
		let headers = new Headers(init?.headers);
		calls.push({
			method,
			path: url.pathname,
			bearer: headers.get("authorization")!.replace("Bearer ", ""),
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
		});
		let [status, body] = answers[`${method} ${url.pathname}`] ?? [404];
		return new Response(body === undefined ? null : JSON.stringify(body), { status });
	};
	let client = new GitHubAppClient(
		{ id: "4242", privateKey },
		{ fetch, api: "https://api.github.test", clock: () => NOW },
	);
	return { client, calls };
}

function claims(jwt: string) {
	let [header, payload, signature] = jwt.split(".");
	expect(
		verify(
			"RSA-SHA256",
			Buffer.from(`${header}.${payload}`),
			publicKey,
			Buffer.from(signature!, "base64url"),
		),
	).toBe(true);
	return {
		header: JSON.parse(Buffer.from(header!, "base64url").toString()),
		payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
	};
}

describe("the GitHub App acting as itself", () => {
	it("signs a JWT GitHub accepts for under ten minutes, a minute early for clock drift", () => {
		let { client } = github({});
		let { header, payload } = claims(client.jwt());
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
		expect(payload).toEqual({ iss: "4242", iat: NOW / 1000 - 60, exp: NOW / 1000 + 540 });
	});

	it("finds its installation on a repository with its JWT, and none where it isn't", async () => {
		let { client, calls } = github({
			"GET /repos/octo-org/score/installation": [200, {
				id: 77,
				suspended_at: null,
				permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			}],
		});
		expect(await client.installation("octo-org", "score")).toEqual({
			id: "77",
			suspended: false,
			permissions: { contents: "write", pull_requests: "write", metadata: "read" },
		});
		expect(await client.installation("octo-org", "other")).toBeUndefined();
		claims(calls[0]!.bearer);
	});

	it("mints a token for one repository with exactly the permissions asked", async () => {
		let { client, calls } = github({
			"POST /app/installations/77/access_tokens": [201, {
				token: "ghs_minted",
				expires_at: "2026-11-12T13:00:00Z",
				permissions: { contents: "write", metadata: "read" },
			}],
		});
		expect(await client.token("77", "score", { contents: "write", metadata: "read" })).toEqual({
			token: "ghs_minted",
			expiresAt: Date.parse("2026-11-12T13:00:00Z"),
			permissions: { contents: "write", metadata: "read" },
		});
		expect(calls[0]).toMatchObject({
			method: "POST",
			body: { repositories: ["score"], permissions: { contents: "write", metadata: "read" } },
		});
		claims(calls[0]!.bearer);
	});

	it("reads an account and whether it can push, with the installation token", async () => {
		let { client, calls } = github({
			"GET /users/chopin-test%5Bbot%5D": [200, {
				login: "chopin-test[bot]",
				id: 900,
				node_id: "BOT",
			}],
			"GET /users/alice": [200, { login: "alice", id: 11, node_id: "U_a", name: "Alice" }],
			"GET /repos/octo-org/score/collaborators/alice/permission": [200, {
				permission: "write",
				user: { permissions: { push: true, admin: false } },
			}],
			"GET /repos/octo-org/score/collaborators/bob/permission": [200, {
				permission: "read",
				user: { permissions: { push: false, admin: false } },
			}],
		});
		expect(await client.account("ghs_x", "chopin-test[bot]")).toEqual({
			login: "chopin-test[bot]",
			id: 900,
			nodeId: "BOT",
		});
		expect(await client.account("ghs_x", "alice")).toMatchObject({ name: "Alice" });
		expect(await client.account("ghs_x", "nobody")).toBeUndefined();
		expect(await client.canPush("ghs_x", "octo-org", "score", "alice")).toBe(true);
		expect(await client.canPush("ghs_x", "octo-org", "score", "bob")).toBe(false);
		expect(await client.canPush("ghs_x", "octo-org", "score", "stranger")).toBe(false);
		expect(calls.every(call => call.bearer === "ghs_x")).toBe(true);
	});

	it("gives a token back, and throws what GitHub won't answer", async () => {
		let { client, calls } = github({
			"DELETE /installation/token": [204],
			"POST /app/installations/77/access_tokens": [500],
		});
		await client.revoke("ghs_old");
		expect(calls[0]).toMatchObject({ method: "DELETE", bearer: "ghs_old" });
		let error = await client.token("77", "score", { contents: "read" }).catch(caught => caught);
		expect(error).toBeInstanceOf(GitHubError);
	});
});
