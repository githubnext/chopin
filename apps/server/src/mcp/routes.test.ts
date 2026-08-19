import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { Router } from "../http/router";
import { GitHubError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerMcpRoutes } from "./routes";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

class GitHubBoundary implements GitHub {
	failure: Error | undefined;
	membership: { state: "active" | "pending"; role: "member" } | undefined;
	membershipFailure: GitHubError | undefined;

	authorize(): string {
		return "";
	}

	async exchange(): Promise<GitHubTokenGrant> {
		return grant("access-token");
	}

	async refresh(): Promise<GitHubTokenGrant> {
		return grant("refreshed-access-token");
	}

	async user(): Promise<GitHubUser> {
		if (this.failure) throw this.failure;
		return { id: "U_octocat", login: "octocat", avatarUrl: "" };
	}

	async organizationMembership() {
		if (this.membershipFailure) throw this.membershipFailure;
		return this.membership;
	}

	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}

	async installationRepositories(): Promise<RepositoryPage> {
		return this.repositories();
	}

	async repository(): Promise<Repository> {
		throw new Error("not used by MCP route tests");
	}

	async repositoryAccess(): Promise<Repository | undefined> {
		throw new Error("not used by MCP route tests");
	}

	invalidate(): void {}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 15_897_600,
	};
}

function setup(overrides: Partial<HostedAuth["config"]> = {}) {
	let now = new Date("2026-08-17T12:00:00.000Z");
	let storage = new MemoryStorage();
	let github = new GitHubBoundary();
	let key = new Uint8Array(32).fill(3);
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: key,
		...overrides,
	};
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions: new Sessions(storage, true, () => now),
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

function expectProtected(response: Response | undefined): void {
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
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
		expectProtected(initialized);
		expect(await initialized?.json()).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: { serverInfo: { name: "chopin" } },
		});
		expect(stream?.status).toBe(200);
		expectProtected(stream);
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
			expectProtected(response);
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
		expectProtected(response);
		expect(text).toBe("MCP request failed");
		expect(text).not.toContain("access-token");
		expect(text).not.toContain("Private roadmap");
	});

	it("distinguishes denied and temporarily unverifiable organization admission", async () => {
		let denied = setup({ allowedOrganizations: new Set(["githubnext"]) });
		let deniedResponse = await denied.router.handle(request("POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}));
		expect(deniedResponse?.status).toBe(403);
		expect(await deniedResponse?.text()).toBe("forbidden");
		expectProtected(deniedResponse);

		let unavailable = setup({ allowedOrganizations: new Set(["githubnext"]) });
		unavailable.github.membershipFailure = new GitHubError("permission missing", 403);
		let unavailableResponse = await unavailable.router.handle(request("POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}));
		expect(unavailableResponse?.status).toBe(503);
		expect(await unavailableResponse?.text()).toBe("admission is temporarily unavailable");
		expectProtected(unavailableResponse);

		let member = setup({ allowedOrganizations: new Set(["githubnext"]) });
		member.github.membership = { state: "active", role: "member" };
		let memberResponse = await member.router.handle(request("POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		}));
		expect(memberResponse?.status).toBe(200);
	});
});
