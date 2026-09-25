import { createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";

import type { MCPClientConfig } from "@ai-sdk/mcp";
import type { Tool, ToolSet } from "ai";

import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { HostedRepository } from "../agent/repository";

const MCP_URL = "https://api.githubcopilot.com/mcp/";

export type GitHubToolsError =
	| { kind: "Unavailable"; cause: unknown }
	| { kind: "MissingTool"; name: string };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * `schemas` loads only these tools from the remote GitHub MCP server. Descriptions
 * are Chopin's own, never the remote server's; both schemas omit `owner`/`repo` because
 * `bindRepository` supplies them from call-time context, not model input.
 */
export const GITHUB_TOOL_SCHEMAS = {
	list_pull_requests: {
		inputSchema: z.object({
			state: z.string().optional(),
			base: z.string().optional(),
			head: z.string().optional(),
			sort: z.string().optional(),
			direction: z.string().optional(),
			page: z.number().optional(),
			perPage: z.number().optional(),
		}),
	},
	pull_request_read: {
		inputSchema: z.object({
			method: z.enum([
				"get",
				"get_diff",
				"get_status",
				"get_files",
				"get_commits",
				"get_review_comments",
				"get_reviews",
				"get_comments",
				"get_check_runs",
			]),
			pullNumber: z.number(),
			page: z.number().optional(),
			perPage: z.number().optional(),
			after: z.string().optional(),
		}),
	},
} as const;

const GITHUB_TOOL_DESCRIPTIONS: Record<keyof typeof GITHUB_TOOL_SCHEMAS, string> = {
	list_pull_requests: "List pull requests in the selected repository.",
	pull_request_read: "Read one pull request in the selected repository: its details, diff, status, "
		+ "changed files, commits, review comments, reviews, issue comments, or check runs.",
};

const RepositoryContextSchema = z.object({
	repository: z.custom<HostedRepository>(),
});

class MissingToolError extends Error {
	constructor(readonly toolName: string) {
		super(`GitHub tool ${toolName} is unavailable`);
	}
}

/**
 * Rebuilds each tool with Chopin's own description and overwrites `owner`/`repo`
 * from `context.repository`. All other input fields pass through verbatim.
 */
export function bindRepository(tools: ToolSet, descriptions: Record<string, string>): ToolSet {
	let bound: ToolSet = {};
	for (let [name, source] of Object.entries(tools)) {
		let description = descriptions[name];
		let execute = source.execute;
		if (description === undefined || !execute) throw new MissingToolError(name);
		bound[name] = tool({
			description,
			inputSchema: source.inputSchema,
			contextSchema: RepositoryContextSchema,
			execute: (input, options) => {
				let context = options.context as { repository: HostedRepository };
				let overridden = {
					...(input as Record<string, unknown>),
					owner: context.repository.owner,
					repo: context.repository.name,
				};
				return execute(overridden, options);
			},
		}) as Tool;
	}
	return bound;
}

/** Picks exactly `names` from `tools`, or reports the first one missing. */
export function requireTools(
	tools: ToolSet,
	names: readonly string[],
): Result<ToolSet, { kind: "MissingTool"; name: string }> {
	let picked: ToolSet = {};
	for (let name of names) {
		let found = tools[name];
		if (!found) return { ok: false, error: { kind: "MissingTool", name } };
		picked[name] = found;
	}
	return { ok: true, value: picked };
}

function credentialKey(owner: ActiveOwnerBinding): string {
	return owner.ownerSessionId;
}

/**
 * `ActiveOwnerBindings#release()` aborts a binding's signal with reason `"released"`
 * once per turn even though the underlying credential (session + revision) is still
 * live for the next turn; every other abort reason (rotation, expiry, revocation,
 * channel reset, runtime stop) means the credential itself is gone. Only the latter
 * should close the cached client.
 */
const RETAINED_ABORT_REASONS = new Set(["released"]);

function abortRetainsCredential(signal: AbortSignal): boolean {
	let reason = signal.reason;
	let message = reason instanceof Error ? reason.message : String(reason ?? "");
	return RETAINED_ABORT_REASONS.has(message);
}

/** Minimal shape of `MCPClient` this module depends on; keeps the test seam decoupled
 * from `MCPClient.tools()`'s generic overloads. */
type MinimalMCPClient = {
	tools(options: { schemas: typeof GITHUB_TOOL_SCHEMAS }): Promise<ToolSet>;
	close(): Promise<void>;
};

type CreateClient = (config: MCPClientConfig) => Promise<MinimalMCPClient>;

type CacheEntry = {
	client: Pick<MinimalMCPClient, "close">;
	token: string;
	credentialRevision: number;
	expiresAt: number;
	result: Result<ToolSet, GitHubToolsError>;
	timer: ReturnType<typeof setTimeout>;
	evicted: boolean;
};

const MAX_TIMEOUT_MS = 2_147_483_647;

const cache = new Map<string, CacheEntry>();
type Opening = {
	token: string;
	credentialRevision: number;
	promise: Promise<Result<ToolSet, GitHubToolsError>>;
};

const openings = new Map<string, Opening>();

async function closeQuietly(client: Pick<MinimalMCPClient, "close">): Promise<void> {
	try {
		await client.close();
	} catch {
		// Closing a client that already failed to connect is not itself an error.
	}
}

function evict(key: string, entry: CacheEntry): void {
	if (entry.evicted) return;
	entry.evicted = true;
	clearTimeout(entry.timer);
	if (cache.get(key) === entry) cache.delete(key);
	void closeQuietly(entry.client);
}

/**
 * Closes `entry` once `owner`'s binding ends for a reason other than a plain per-turn
 * release. Safe to call on every reuse of a cached entry: eviction is idempotent, and a
 * cache hit from a fresh `resolve()` call carries a fresh, not-yet-aborted signal that
 * still needs its own listener.
 */
function watch(key: string, entry: CacheEntry, owner: ActiveOwnerBinding): void {
	if (owner.signal.aborted) {
		if (!abortRetainsCredential(owner.signal)) evict(key, entry);
		return;
	}
	owner.signal.addEventListener("abort", () => {
		if (!abortRetainsCredential(owner.signal)) evict(key, entry);
	}, { once: true });
}

function unavailable(cause: unknown): Result<ToolSet, GitHubToolsError> {
	return { ok: false, error: { kind: "Unavailable", cause } };
}

/**
 * Returns host-executed AI SDK tools bound to `owner`'s repository. Read-only,
 * `pull_requests`-only GitHub MCP tools reachable with `owner`'s token: no schema has
 * an `owner`/`repo` field and `bindRepository` overwrites both from call-time context,
 * so a model cannot name another repository. Search tools are not in the allowlist and
 * are silently dropped by the MCP client if the server ever offers them.
 *
 * Caches one client per owner session and current credential, reused across calls
 * whose token and revision still match. A rotation closes the previous credential's
 * client even when the previous binding was released. An expired, revoked, or
 * in-flight superseded binding never populates the cache.
 */
export async function githubTools(
	owner: ActiveOwnerBinding,
	deps: { createClient?: CreateClient } = {},
): Promise<Result<ToolSet, GitHubToolsError>> {
	if (owner.signal.aborted || owner.expiresAt.getTime() <= Date.now()) {
		return unavailable(owner.signal.reason ?? new Error("owner binding is no longer valid"));
	}

	let key = credentialKey(owner);
	let cached = cache.get(key);
	if (
		cached && cached.token === owner.token
		&& cached.credentialRevision === owner.credentialRevision
		&& cached.expiresAt > Date.now()
	) {
		watch(key, cached, owner);
		return cached.result;
	}
	if (cached) evict(key, cached);

	let existing = openings.get(key);
	if (existing?.token === owner.token && existing.credentialRevision === owner.credentialRevision) {
		let result = await existing.promise;
		if (owner.signal.aborted || owner.expiresAt.getTime() <= Date.now()) {
			return unavailable(owner.signal.reason ?? new Error("owner binding is no longer valid"));
		}
		let entry = cache.get(key);
		if (entry) watch(key, entry, owner);
		return result;
	}

	let opening: Opening;
	let connect = async (): Promise<Result<ToolSet, GitHubToolsError>> => {
		let createClient = deps.createClient ?? (createMCPClient as CreateClient);
		let client: MinimalMCPClient;
		try {
			client = await createClient({
				transport: {
					type: "http",
					url: MCP_URL,
					headers: {
						Authorization: `Bearer ${owner.token}`,
						"X-MCP-Readonly": "true",
						"X-MCP-Toolsets": "pull_requests",
					},
				},
			});
		} catch (cause) {
			return unavailable(cause);
		}

		let raw: ToolSet;
		try {
			raw = await client.tools({ schemas: GITHUB_TOOL_SCHEMAS });
		} catch (cause) {
			await closeQuietly(client);
			return unavailable(cause);
		}

		if (
			owner.signal.aborted || owner.expiresAt.getTime() <= Date.now()
			|| openings.get(key) !== opening
		) {
			await closeQuietly(client);
			return unavailable(
				owner.signal.reason ?? new Error("owner credential changed while loading tools"),
			);
		}

		let picked = requireTools(raw, Object.keys(GITHUB_TOOL_SCHEMAS));
		if (!picked.ok) {
			await closeQuietly(client);
			return picked;
		}
		let bound: ToolSet;
		try {
			bound = bindRepository(picked.value, GITHUB_TOOL_DESCRIPTIONS);
		} catch (cause) {
			await closeQuietly(client);
			return cause instanceof MissingToolError
				? { ok: false, error: { kind: "MissingTool", name: cause.toolName } }
				: unavailable(cause);
		}

		let entry: CacheEntry = {
			client,
			token: owner.token,
			credentialRevision: owner.credentialRevision,
			expiresAt: owner.expiresAt.getTime(),
			result: { ok: true, value: bound },
			evicted: false,
			timer: undefined as unknown as ReturnType<typeof setTimeout>,
		};
		entry.timer = setTimeout(
			() => evict(key, entry),
			Math.min(Math.max(0, owner.expiresAt.getTime() - Date.now()), MAX_TIMEOUT_MS),
		);
		cache.set(key, entry);
		watch(key, entry, owner);
		return entry.result;
	};
	opening = {
		token: owner.token,
		credentialRevision: owner.credentialRevision,
		promise: connect(),
	};
	openings.set(key, opening);
	try {
		return await opening.promise;
	} finally {
		if (openings.get(key) === opening) openings.delete(key);
	}
}
