import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerMcpRoutes } from "./routes";

import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubUser, Repository, RepositoryPage } from "../github/client";

class GitHubBoundary implements GitHub {
	failure: Error | undefined;

	authorize(): string {
		return "";
	}

	async exchange(): Promise<string> {
		return "";
	}

	async user(): Promise<GitHubUser> {
		if (this.failure) throw this.failure;
		return { id: "U_octocat", login: "octocat", avatarUrl: "" };
	}

	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async repository(): Promise<Repository> {
		throw new Error("not used by MCP route tests");
	}

	async repositoryAccess(): Promise<Repository | undefined> {
		throw new Error("not used by MCP route tests");
	}
}

function setup() {
	let now = new Date("2026-08-17T12:00:00.000Z");
	let storage = new MemoryStorage();
	let github = new GitHubBoundary();
	let key = new Uint8Array(32).fill(3);
	let auth: HostedAuth = {
		config: {
			origin: "https://chopin.test",
			clientId: "client-id",
			clientSecret: "client-secret",
			encryptionKey: key,
		},
		storage,
		github,
		sessions: new Sessions(storage, key, true, () => now),
		clock: () => now,
	};
	let router = new Router();
	registerMcpRoutes(router, auth);
	return { github, router };
}

function request(method: string, init: RequestInit = {}): Request {
	let headers = new Headers({ authorization: "Bearer access-token", ...init.headers });
	return new Request("https://chopin.test/mcp", { method, ...init, headers });
}

describe("the hosted MCP route", () => {
	it("passes originless POST and same-origin GET requests to authenticated MCP", async () => {
		let { router } = setup();
		let initialized = await router.handle(request("POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}));
		let stream = await router.handle(request("GET", {
			headers: { origin: "https://chopin.test", accept: "text/event-stream" },
		}));

		expect(initialized?.status).toBe(200);
		expect(await initialized?.json()).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: { serverInfo: { name: "chopin" } },
		});
		expect(stream?.status).toBe(200);
		expect(stream?.headers.get("content-type")).toBe("text/event-stream");
	});

	it("rejects every supplied Origin except the configured one", async () => {
		let { router } = setup();
		for (let origin of ["https://attacker.test", ""]) {
			let response = await router.handle(request("POST", {
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			}));

			expect(response?.status).toBe(403);
			expect(await response?.text()).toBe("origin is not allowed");
		}
	});

	it("does not disclose hosted failures through MCP", async () => {
		let { github, router } = setup();
		github.failure = new Error("access-token foreign document: Private roadmap");
		let response = await router.handle(request("POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}));
		let text = await response?.text();

		expect(response?.status).toBe(500);
		expect(text).toBe("MCP request failed");
		expect(text).not.toContain("access-token");
		expect(text).not.toContain("Private roadmap");
	});
});
