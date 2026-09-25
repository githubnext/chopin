import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import { bindRepository, GITHUB_TOOL_SCHEMAS, githubTools } from "./github-tools";

import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { HostedRepository } from "../agent/repository";
import type { MCPClientConfig } from "@ai-sdk/mcp";
import type { Tool, ToolSet } from "ai";

const CHOPIN_LIST_DESCRIPTION = "List pull requests in the selected repository.";
const CHOPIN_READ_DESCRIPTION =
	"Read one pull request in the selected repository: its details, diff, status, "
	+ "changed files, commits, review comments, reviews, issue comments, or check runs.";

function repository(overrides: Partial<HostedRepository> = {}): HostedRepository {
	return { id: "R_1", owner: "acme", name: "widgets", defaultBranch: "main", ...overrides };
}

function fakeOwner(overrides: Partial<ActiveOwnerBinding> = {}): ActiveOwnerBinding {
	return {
		channelId: "channel-1",
		token: "gh-owner-token",
		repository: repository(),
		ownerSessionId: crypto.randomUUID(),
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		signal: new AbortController().signal,
		currentToken: () => "gh-owner-token",
		revalidate: async () => true,
		release: () => {},
		...overrides,
	};
}

function remoteTool(name: string): Tool {
	return tool({
		description: `remote description for ${name} (must never be used)`,
		inputSchema: z.object({
			owner: z.string().optional(),
			repo: z.string().optional(),
			pullNumber: z.number().optional(),
			state: z.string().optional(),
			perPage: z.number().optional(),
			method: z.string().optional(),
		}),
		execute: async () => ({ name, remote: true }),
	});
}

type FakeClient = {
	tools(options: { schemas: Record<string, unknown> }): Promise<ToolSet>;
	close(): Promise<void>;
};

function fakeCreateClient(
	toolNames: string[],
	options: { onCreate?: (config: MCPClientConfig) => void; onClose?: () => void } = {},
): (config: MCPClientConfig) => Promise<FakeClient> {
	return async config => {
		options.onCreate?.(config);
		return {
			async tools({ schemas }: { schemas: Record<string, unknown> }) {
				let allowed = Object.keys(schemas);
				let out: ToolSet = {};
				for (let name of toolNames) {
					if (allowed.includes(name)) out[name] = remoteTool(name);
				}
				return out;
			},
			async close() {
				options.onClose?.();
			},
		};
	};
}

test("GitHub schema allowlist has exactly two tools and all nine pull_request_read methods", () => {
	expect(Object.keys(GITHUB_TOOL_SCHEMAS).sort()).toEqual([
		"list_pull_requests",
		"pull_request_read",
	]);
	let methods = [
		"get",
		"get_diff",
		"get_status",
		"get_files",
		"get_commits",
		"get_review_comments",
		"get_reviews",
		"get_comments",
		"get_check_runs",
	] as const;
	expect(GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema.shape.method.options)
		.toEqual([...methods]);
	for (let method of methods) {
		expect(
			GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema.safeParse({
				method,
				pullNumber: 1,
			}).success,
		).toBe(true);
	}
	expect(
		GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema.safeParse({
			method: "search_pull_requests",
			pullNumber: 1,
		}).success,
	).toBe(false);
	expect(Object.keys(GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema.shape))
		.not.toContain("owner");
	expect(Object.keys(GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema.shape))
		.not.toContain("repo");
});

describe("bindRepository", () => {
	test("overwrites forged owner/repo input from context, ignoring the caller's values", async () => {
		let calls: unknown[] = [];
		let fake: ToolSet = {
			pull_request_read: tool({
				description: "remote description (must not appear)",
				inputSchema: z.object({
					owner: z.string().optional(),
					repo: z.string().optional(),
					pullNumber: z.number(),
				}),
				execute: async input => {
					calls.push(input);
					return "ok";
				},
			}),
		};
		let bound = bindRepository(fake, { pull_request_read: "Chopin's own description" });
		expect(bound.pull_request_read?.description).toBe("Chopin's own description");
		await bound.pull_request_read?.execute?.(
			{ owner: "forged-owner", repo: "forged-repo", pullNumber: 7 },
			{
				toolCallId: "call-1",
				messages: [],
				context: { repository: repository({ owner: "real-owner", name: "real-repo" }) },
			},
		);
		expect(calls).toEqual([{ owner: "real-owner", repo: "real-repo", pullNumber: 7 }]);
	});

	test("preserves optional, empty, and verbatim input fields outside owner/repo", async () => {
		let calls: unknown[] = [];
		let fake: ToolSet = {
			list_pull_requests: tool({
				description: "remote description (must not appear)",
				inputSchema: z.object({ state: z.string().optional(), perPage: z.number().optional() }),
				execute: async input => {
					calls.push(input);
					return "ok";
				},
			}),
		};
		let bound = bindRepository(fake, { list_pull_requests: "Chopin's list description" });
		let context = { repository: repository() };
		await bound.list_pull_requests?.execute?.({}, { toolCallId: "1", messages: [], context });
		await bound.list_pull_requests?.execute?.(
			{ state: "open", perPage: 10 },
			{ toolCallId: "2", messages: [], context },
		);
		expect(calls).toEqual([
			{ owner: "acme", repo: "widgets" },
			{ owner: "acme", repo: "widgets", state: "open", perPage: 10 },
		]);
	});

	test("reports a tool with no mapped Chopin description as MissingTool, never using the remote one", () => {
		let fake: ToolSet = {
			list_pull_requests: tool({
				description: "remote description (must not leak)",
				inputSchema: z.object({}),
				execute: async () => "ok",
			}),
		};
		expect(() => bindRepository(fake, {})).toThrow("GitHub tool list_pull_requests is unavailable");
	});

	test("reports a tool with no execute function as MissingTool instead of dropping it silently", () => {
		let fake: ToolSet = {
			list_pull_requests: tool({ inputSchema: z.object({}), outputSchema: z.string() }),
		};
		expect(() => bindRepository(fake, { list_pull_requests: "Chopin's list description" }))
			.toThrow("GitHub tool list_pull_requests is unavailable");
	});
});

describe("githubTools", () => {
	test("requests the read-only pull_requests toolset with the owner's token over HTTP", async () => {
		let seen: MCPClientConfig | undefined;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: config => {
				seen = config;
			},
		});
		let owner = fakeOwner({ token: "specific-owner-token" });
		let result = await githubTools(owner, { createClient });
		expect(result.ok).toBe(true);
		expect(seen?.transport).toMatchObject({
			type: "http",
			url: "https://api.githubcopilot.com/mcp/",
			headers: {
				Authorization: "Bearer specific-owner-token",
				"X-MCP-Readonly": "true",
				"X-MCP-Toolsets": "pull_requests",
			},
		});
	});

	test("returns exactly list_pull_requests and pull_request_read with Chopin's own descriptions", async () => {
		let createClient = fakeCreateClient([
			"list_pull_requests",
			"pull_request_read",
			"search_pull_requests",
			"search_code",
		]);
		let result = await githubTools(fakeOwner(), { createClient });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(Object.keys(result.value).sort()).toEqual(["list_pull_requests", "pull_request_read"]);
		expect(result.value.list_pull_requests?.description).toBe(CHOPIN_LIST_DESCRIPTION);
		expect(result.value.pull_request_read?.description).toBe(CHOPIN_READ_DESCRIPTION);
	});

	test("a tool missing from the remote server maps to MissingTool", async () => {
		let createClient = fakeCreateClient(["list_pull_requests"]);
		let result = await githubTools(fakeOwner(), { createClient });
		expect(result).toEqual({
			ok: false,
			error: { kind: "MissingTool", name: "pull_request_read" },
		});
	});

	test("a non-executable allowlisted tool maps to MissingTool", async () => {
		let closed = 0;
		let result = await githubTools(fakeOwner(), {
			createClient: async () => ({
				tools: async () => ({
					list_pull_requests: remoteTool("list_pull_requests"),
					pull_request_read: tool({ inputSchema: z.object({}), outputSchema: z.string() }),
				}),
				close: async () => {
					closed++;
				},
			}),
		});
		expect(result).toEqual({
			ok: false,
			error: { kind: "MissingTool", name: "pull_request_read" },
		});
		expect(closed).toBe(1);
	});

	test("a connection failure maps to Unavailable", async () => {
		let cause = new Error("network down");
		let createClient = async (): Promise<never> => {
			throw cause;
		};
		let result = await githubTools(fakeOwner(), { createClient });
		expect(result).toEqual({ ok: false, error: { kind: "Unavailable", cause } });
	});

	test("a failure while listing tools maps to Unavailable and closes the client", async () => {
		let closed = 0;
		let createClient = async () => ({
			async tools() {
				throw new Error("tools listing failed");
			},
			async close() {
				closed++;
			},
		});
		let result = await githubTools(fakeOwner(), { createClient });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error.kind).toBe("Unavailable");
		expect(closed).toBe(1);
	});

	test("reuses one client across a per-turn release, not just within one call", async () => {
		let sessionId = crypto.randomUUID();
		let created = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => {
				created++;
			},
		});

		let firstController = new AbortController();
		let first = await githubTools(
			fakeOwner({ ownerSessionId: sessionId, signal: firstController.signal }),
			{ createClient },
		);
		firstController.abort(new Error("released"));

		let secondController = new AbortController();
		let second = await githubTools(
			fakeOwner({ ownerSessionId: sessionId, signal: secondController.signal }),
			{ createClient },
		);

		expect(created).toBe(1);
		expect(second).toBe(first);
	});

	test("closes the cached client and reconnects when the credential rotates", async () => {
		let sessionId = crypto.randomUUID();
		let created = 0;
		let closed = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => {
				created++;
			},
			onClose: () => {
				closed++;
			},
		});

		let firstController = new AbortController();
		await githubTools(
			fakeOwner({
				ownerSessionId: sessionId,
				credentialRevision: 1,
				signal: firstController.signal,
			}),
			{ createClient },
		);
		firstController.abort(new Error("credential-rotated"));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(closed).toBe(1);

		await githubTools(
			fakeOwner({
				ownerSessionId: sessionId,
				credentialRevision: 2,
				token: "rotated-token",
				signal: new AbortController().signal,
			}),
			{ createClient },
		);
		expect(created).toBe(2);
	});

	test("refuses an already-aborted owner binding without creating a client", async () => {
		let sessionId = crypto.randomUUID();
		let created = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => {
				created++;
			},
		});
		let controller = new AbortController();
		await githubTools(fakeOwner({ ownerSessionId: sessionId, signal: controller.signal }), {
			createClient,
		});
		expect(created).toBe(1);

		controller.abort(new Error("credential-rotated"));
		let result = await githubTools(
			fakeOwner({ ownerSessionId: sessionId, signal: controller.signal }),
			{ createClient },
		);
		expect(created).toBe(1);
		expect(result).toEqual({
			ok: false,
			error: { kind: "Unavailable", cause: controller.signal.reason },
		});
	});

	test("does not reuse a cached client whose token no longer matches the owner binding", async () => {
		let sessionId = crypto.randomUUID();
		let created = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => {
				created++;
			},
		});
		await githubTools(fakeOwner({ ownerSessionId: sessionId, token: "token-a" }), { createClient });
		await githubTools(fakeOwner({ ownerSessionId: sessionId, token: "token-b" }), { createClient });
		expect(created).toBe(2);
	});

	test("closes the cached client at expiry even without an abort", async () => {
		let closed = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onClose: () => {
				closed++;
			},
		});
		await githubTools(fakeOwner({ expiresAt: new Date(Date.now() + 20) }), { createClient });
		expect(closed).toBe(0);
		await new Promise(resolve => setTimeout(resolve, 60));
		expect(closed).toBe(1);
	});

	test("discards and closes a client whose owner binding aborted while tools were loading", async () => {
		let closed = 0;
		let controller = new AbortController();
		let release!: () => void;
		let gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let createClient = async () => ({
			async tools() {
				await gate;
				return {
					list_pull_requests: remoteTool("list_pull_requests"),
					pull_request_read: remoteTool("pull_request_read"),
				};
			},
			async close() {
				closed++;
			},
		});
		let pending = githubTools(fakeOwner({ signal: controller.signal }), { createClient });
		controller.abort(new Error("credential-rotated"));
		release();
		let result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error.kind).toBe("Unavailable");
		expect(closed).toBe(1);
	});

	test("rotation after a released turn closes the previous credential's client", async () => {
		let sessionId = crypto.randomUUID();
		let closed = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onClose: () => closed++,
		});
		let controller = new AbortController();
		await githubTools(fakeOwner({ ownerSessionId: sessionId, signal: controller.signal }), {
			createClient,
		});
		controller.abort(new Error("released"));
		await githubTools(
			fakeOwner({
				ownerSessionId: sessionId,
				credentialRevision: 2,
				token: "new-token",
			}),
			{ createClient },
		);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(closed).toBe(1);
	});

	test("concurrent opens for one credential share a single MCP connection", async () => {
		let created = 0;
		let release!: () => void;
		let gate = new Promise<void>(resolve => release = resolve);
		let client = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => created++,
		});
		let createClient: typeof client = async config => {
			let connected = await client(config);
			await gate;
			return connected;
		};
		let owner = fakeOwner();
		let first = githubTools(owner, { createClient });
		let second = githubTools(owner, { createClient });
		release();
		let results = await Promise.all([first, second]);
		expect(created).toBe(1);
		expect(results[0]).toBe(results[1]);
	});

	test("a superseded in-flight connection cannot replace a rotated credential", async () => {
		let sessionId = crypto.randomUUID();
		let created = 0;
		let closed = 0;
		let release!: () => void;
		let gate = new Promise<void>(resolve => release = resolve);
		let client = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => created++,
			onClose: () => closed++,
		});
		let createClient: typeof client = async config => {
			let connected = await client(config);
			if (
				new Headers((config.transport as { headers?: Record<string, string> }).headers)
					.get("authorization") === "Bearer older"
			) await gate;
			return connected;
		};
		let older = githubTools(fakeOwner({ ownerSessionId: sessionId, token: "older" }), {
			createClient,
		});
		let newer = await githubTools(
			fakeOwner({
				ownerSessionId: sessionId,
				credentialRevision: 2,
				token: "newer",
			}),
			{ createClient },
		);
		release();
		expect((await older).ok).toBe(false);
		expect(newer.ok).toBe(true);
		expect(created).toBe(2);
		expect(closed).toBe(1);
	});

	test("does not cache a client for a different owner credential", async () => {
		let created = 0;
		let createClient = fakeCreateClient(["list_pull_requests", "pull_request_read"], {
			onCreate: () => {
				created++;
			},
		});
		await githubTools(fakeOwner({ ownerSessionId: "session-a" }), { createClient });
		await githubTools(fakeOwner({ ownerSessionId: "session-b" }), { createClient });
		expect(created).toBe(2);
	});
});
