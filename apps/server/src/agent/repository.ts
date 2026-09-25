import { jsonSchema, tool } from "ai";
import { z } from "zod";

export type HostedRepository = {
	id: string;
	owner: string;
	name: string;
	defaultBranch: string;
};

type Options = {
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 5 * 1_024 * 1_024;

function root(repository: HostedRepository): string {
	return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function path(value: unknown): string {
	if (typeof value !== "string") throw new Error("path must be a string");
	let normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
	if (
		!normalized || normalized.startsWith("/")
		|| normalized.split("/").some(part => !part || part === "..")
	) {
		throw new Error("path must be a relative repository path");
	}
	return normalized;
}

function encodedPath(value: string): string {
	return value.split("/").map(encodeURIComponent).join("/");
}

function bounded(value: unknown, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`limit must be an integer between 1 and ${maximum}`);
	}
	return value;
}

function text(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${name} must be between 1 and ${maximum} characters`);
	}
	return value.trim();
}

async function answer(work: () => Promise<unknown>): Promise<string> {
	try {
		return JSON.stringify(await work(), null, 2);
	} catch (err) {
		return `Error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export function repositoryTools(options: Options = {}) {
	let repositoryContext = z.object({
		repository: z.object({
			id: z.string(),
			owner: z.string(),
			name: z.string(),
			defaultBranch: z.string(),
		}),
		owner: z.custom<{ currentToken: () => string | undefined }>(),
	});
	let request = async (
		context: z.infer<typeof repositoryContext>,
		path: string,
		search?: URLSearchParams,
	): Promise<unknown> => {
		let token = context.owner.currentToken();
		if (!token) throw new Error("GitHub authorization expired");
		let url = new URL(path, API);
		if (search) url.search = search.toString();
		let response = await (options.fetch ?? fetch)(url, {
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": "chopin",
				"x-github-api-version": "2022-11-28",
			},
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`GitHub repository read failed (${response.status})`);
		let source = await response.text();
		if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) {
			throw new Error("GitHub response is too large");
		}
		try {
			return JSON.parse(source);
		} catch {
			throw new Error("GitHub returned an unreadable response");
		}
	};
	return {
		read_repository_file: tool({
			contextSchema: repositoryContext,
			description: "Read a UTF-8 text file from the selected repository, optionally by line range.",
			inputSchema: jsonSchema({
				type: "object",
				properties: {
					path: { type: "string" },
					start: { type: "integer", minimum: 1 },
					end: { type: "integer", minimum: 1 },
				},
				required: ["path"],
				additionalProperties: false,
			}),
			metadata: { skipPermission: true },
			execute: (raw, { context }) =>
				answer(async () => {
					let input = raw as Record<string, unknown>;
					let file = path(input.path);
					let value = object(
						await request(
							context,
							`${root(context.repository)}/contents/${encodedPath(file)}`,
							new URLSearchParams({ ref: context.repository.defaultBranch }),
						),
					);
					if (
						!value || value.type !== "file" || value.encoding !== "base64"
						|| typeof value.content !== "string"
					) {
						throw new Error("GitHub did not return a text file");
					}
					let bytes = Buffer.from(value.content.replace(/\s/g, ""), "base64");
					if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
						throw new Error("file is binary or exceeds 256 KiB");
					}
					let lines = bytes.toString("utf8").split("\n");
					let start = bounded(input.start, 1, Math.max(1, lines.length));
					let end = bounded(input.end, Math.min(lines.length, start + 399), lines.length);
					if (end < start) throw new Error("end must not be before start");
					return {
						path: file,
						start,
						end,
						content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`)
							.join("\n"),
					};
				}),
		}),
		list_repository_tree: tool({
			contextSchema: repositoryContext,
			description:
				"List files in the selected repository's default branch, optionally below a prefix.",
			inputSchema: jsonSchema({
				type: "object",
				properties: {
					prefix: { type: "string" },
					limit: { type: "integer", minimum: 1, maximum: 500 },
				},
				additionalProperties: false,
			}),
			metadata: { skipPermission: true },
			execute: (raw, { context }) =>
				answer(async () => {
					let input = raw as Record<string, unknown>;
					let prefix = input.prefix === undefined ? "" : path(input.prefix);
					let limit = bounded(input.limit, 200, 500);
					let value = object(
						await request(
							context,
							`${root(context.repository)}/git/trees/${
								encodeURIComponent(context.repository.defaultBranch)
							}`,
							new URLSearchParams({ recursive: "1" }),
						),
					);
					if (!value || !Array.isArray(value.tree)) {
						throw new Error("GitHub returned an invalid tree");
					}
					let entries = value.tree.flatMap(entry => {
						let item = object(entry);
						return item && typeof item.path === "string" && typeof item.type === "string"
								&& (!prefix || item.path === prefix || item.path.startsWith(`${prefix}/`))
							? [{
								path: item.path,
								type: item.type,
								size: typeof item.size === "number" ? item.size : undefined,
							}]
							: [];
					}).slice(0, limit);
					return { entries, truncated: value.truncated === true || entries.length >= limit };
				}),
		}),
		search_repository: tool({
			contextSchema: repositoryContext,
			description: "Search code terms within the selected repository only.",
			inputSchema: jsonSchema({
				type: "object",
				properties: {
					terms: { type: "string" },
					limit: { type: "integer", minimum: 1, maximum: 50 },
				},
				required: ["terms"],
				additionalProperties: false,
			}),
			metadata: { skipPermission: true },
			execute: (raw, { context }) =>
				answer(async () => {
					let input = raw as Record<string, unknown>;
					let terms = text(input.terms, "terms", 200).replace(/[\r\n]/g, " ");
					let limit = bounded(input.limit, 20, 50);
					let value = object(
						await request(
							context,
							"/search/code",
							new URLSearchParams({
								q: `${terms} repo:${context.repository.owner}/${context.repository.name}`,
								per_page: String(limit),
							}),
						),
					);
					if (!value || !Array.isArray(value.items)) {
						throw new Error("GitHub returned invalid search results");
					}
					let matches = value.items.flatMap(entry => {
						let item = object(entry);
						let repository = object(item?.repository);
						return item && repository?.node_id === context.repository.id
								&& typeof item.path === "string"
							? [{
								path: item.path,
								url: typeof item.html_url === "string" ? item.html_url : undefined,
							}]
							: [];
					});
					return { matches };
				}),
		}),
		repository_history: tool({
			contextSchema: repositoryContext,
			description:
				"Read recent commits from the selected repository, optionally affecting one path.",
			inputSchema: jsonSchema({
				type: "object",
				properties: {
					path: { type: "string" },
					limit: { type: "integer", minimum: 1, maximum: 20 },
				},
				additionalProperties: false,
			}),
			metadata: { skipPermission: true },
			execute: (raw, { context }) =>
				answer(async () => {
					let input = raw as Record<string, unknown>;
					let limit = bounded(input.limit, 10, 20);
					let query = new URLSearchParams({
						sha: context.repository.defaultBranch,
						per_page: String(limit),
					});
					if (input.path !== undefined) query.set("path", path(input.path));
					let value = await request(context, `${root(context.repository)}/commits`, query);
					if (!Array.isArray(value)) throw new Error("GitHub returned invalid commit history");
					return value.slice(0, limit).flatMap(entry => {
						let item = object(entry);
						let commit = object(item?.commit);
						let author = object(commit?.author);
						return item && typeof item.sha === "string" && commit
								&& typeof commit.message === "string"
							? [{
								sha: item.sha,
								message: commit.message,
								author: author?.name,
								date: author?.date,
							}]
							: [];
					});
				}),
		}),
	};
}
