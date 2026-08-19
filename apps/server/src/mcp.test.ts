import { describe, expect, it } from "bun:test";

import { limits } from "@chopin/dialect";

import { handler, TOOLS } from "./mcp";

import type {
	CreateDocument,
	CreateDocumentInput,
	Document,
	DocumentReader,
	Implementations,
} from "./mcp";
import type { Run } from "./tasks/graphs";

const document: Document = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Release readiness",
	source: "# Release readiness\n",
	revision: 4,
};

let creation = {
	idempotencyKey: "create-plan-1",
	repository: "githubnext/chopin",
	baseBranch: "main",
	baseCommit: "0123456789abcdef0123456789abcdef01234567",
	title: "Ship MCP creation",
	brief: {
		goal: "Create a collaborative plan.",
		constraints: ["Keep plans immutable through MCP."],
		settledDecisions: ["Use the documented dialect."],
		openQuestions: ["Which reviewer owns the rollout?"],
		repositoryFindings: ["The plan becomes a hosted channel."],
	},
	plan: '# Draft\n\n<Callout type="note">\nCreated through MCP.\n</Callout>\n',
};

function request(
	body: unknown,
	init: RequestInit = {},
): Request {
	let headers = new Headers({
		authorization: "Bearer allowed",
		"content-type": "application/json",
		...init.headers,
	});
	return new Request("https://chopin.test/mcp", {
		method: "POST",
		...init,
		headers,
		body: JSON.stringify(body),
	});
}

function reader(): DocumentReader<string> {
	return {
		async list(caller, repository) {
			return caller === "octocat" && repository === "githubnext/chopin"
				? [{ id: document.id, title: document.title }]
				: [];
		},
		async read(caller, id) {
			return caller === "octocat" && id === document.id ? document : undefined;
		},
	};
}

function unavailable(): CreateDocument<string> {
	return {
		async create() {
			return { kind: "forbidden" };
		},
	};
}

function endpoint() {
	return handler({
		caller: request =>
			request.headers.get("authorization") === "Bearer allowed"
				? "octocat"
				: undefined,
		documents: reader(),
	});
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

describe("the MCP read protocol", () => {
	it("authenticates initialize, lists repository documents, and reads canonical source", async () => {
		let mcp = endpoint();

		let initialized = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			})),
		);
		expect(initialized).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "chopin" },
			},
		});
		let tools = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
			})),
		);
		expect((tools.result as { tools: unknown[] }).tools).toEqual(
			TOOLS.filter(tool => ["list_documents", "read_document"].includes(tool.name)),
		);

		let listed = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "list_documents", arguments: { repository: "githubnext/chopin" } },
			})),
		);
		expect((listed.result as { structuredContent: unknown }).structuredContent).toEqual({
			documents: [{ id: document.id, title: document.title }],
		});

		let read = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: document.id } },
			})),
		);
		expect((read.result as { structuredContent: unknown }).structuredContent).toEqual(document);
	});

	it("reads and claims an implementation through its initialized client session", async () => {
		let active: Run | undefined;
		let implementations: Implementations<string> = {
			async readImplementation(_caller, id) {
				if (id !== document.id) return undefined;
				return {
					document,
					repository: {
						name: "githubnext/chopin",
						baseBranch: "main",
						baseCommit: "abc123",
					},
					graph: {
						number: 1,
						revision: 4,
						planRevision: 4,
						state: "approved",
						definition: { tasks: [] },
					},
					execution: active ? { state: "active", run: active } : { state: "idle" },
					history: [],
				};
			},
			async startImplementation(_caller, input) {
				if (active) return { kind: "active", run: active };
				active = {
					id: "run-1",
					user: "octocat",
					client: { name: input.client.name, version: input.client.version },
					session: input.client.session,
					planRevision: input.planRevision,
					graphVersion: input.graphVersion,
					graphRevision: input.graphRevision,
					repository: input.repository,
					branch: input.branch,
					commit: input.commit,
					startedAt: "2026-08-17T12:00:00.000Z",
				};
				return { kind: "started", run: active };
			},
		};
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: unavailable(),
			implementations,
		});
		let initialized = await mcp(request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "Codex", version: "1.2.3" } },
		}));
		let session = initialized.headers.get("mcp-session-id");
		expect(session).toBeTruthy();

		let read = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "read_implementation", arguments: { id: document.id } },
			})),
		);
		expect((read.result as { structuredContent: unknown }).structuredContent).toMatchObject({
			graph: { state: "approved", revision: 4 },
			execution: { state: "idle" },
		});

		let arguments_ = {
			id: document.id,
			planRevision: 4,
			graphVersion: 1,
			graphRevision: 4,
			repository: "githubnext/chopin",
			branch: "tq/017",
			commit: "deadbeef",
		};
		let withoutSession = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "start_implementation", arguments: arguments_ },
			})),
		);
		expect((withoutSession.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "session-required",
		});

		let claimed = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "start_implementation", arguments: arguments_ },
			}, { headers: { "mcp-session-id": session! } })),
		);
		expect((claimed.result as { structuredContent: unknown }).structuredContent).toMatchObject({
			state: "started",
			run: {
				id: "run-1",
				graphVersion: 1,
				client: { name: "Codex", version: "1.2.3" },
				session,
			},
		});
	});

	it("advertises and dispatches lifecycle tools from one implementation capability", async () => {
		let received: unknown;
		let implementations = {
			async readImplementation() {
				return undefined;
			},
			async startImplementation() {
				return { kind: "refused" as const, reason: "unused" };
			},
			async reportLifecycle(_caller: string, input: unknown) {
				received = input;
				return { kind: "accepted" as const, lifecycle: { activity: "recorded" } };
			},
		};
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			implementations,
		});
		let initialized = await mcp(request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "Codex", version: "1.2.3" } },
		}));
		let session = initialized.headers.get("mcp-session-id")!;
		let listed = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
			}, { headers: { "mcp-session-id": session } })),
		);
		expect((listed.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
			.toEqual(expect.arrayContaining([
				"start_task",
				"block_task",
				"report_pr",
				"complete_task",
				"request_revision",
			]));

		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "block_task",
					arguments: {
						id: document.id,
						runId: "run-1",
						taskId: "model",
						reason: "Waiting for CI.",
						idempotencyKey: "block-model",
					},
				},
			}, { headers: { "mcp-session-id": session } })),
		);
		expect(received).toEqual({
			id: document.id,
			kind: "block",
			runId: "run-1",
			taskId: "model",
			reason: "Waiting for CI.",
			idempotencyKey: "block-model",
		});
		expect((result.result as { structuredContent: unknown }).structuredContent).toEqual({
			activity: "recorded",
		});
	});

	it("keeps the repository-scoped tool schemas static", async () => {
		expect(TOOLS).toEqual(expect.arrayContaining([
			expect.objectContaining({
				name: "list_documents",
				inputSchema: expect.objectContaining({
					required: ["repository"],
					additionalProperties: false,
				}),
			}),
			expect.objectContaining({
				name: "read_document",
				inputSchema: expect.objectContaining({ required: ["id"], additionalProperties: false }),
			}),
		]));
	});

	it("creates a validated canonical document through the host adapter", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller: string, input: CreateDocumentInput) {
					return {
						kind: "created" as const,
						document: {
							id: "created",
							title: input.title,
							brief: input.brief,
							source: input.plan,
							revision: 0,
							url: "/channels/created",
						},
					};
				},
			},
		});

		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "create_document", arguments: creation },
			})),
		);

		expect(result.error).toBeUndefined();
		expect((result.result as { structuredContent: Record<string, unknown> }).structuredContent)
			.toMatchObject({
				id: "created",
				title: creation.title,
				brief: creation.brief,
				revision: 0,
				url: "/channels/created",
			});
		expect(
			(result.result as { structuredContent: { source: string } }).structuredContent.source,
		).toMatch(/<Callout (?=[^>]*id="[0-7][0-9A-HJKMNP-TV-Z]{25}")(?=[^>]*type="note")/);
	});

	it("returns dialect issues without asking the host to persist an invalid plan", async () => {
		let created = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					created = true;
					return { kind: "forbidden" as const };
				},
			},
		});

		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: {
					name: "create_document",
					arguments: { ...creation, plan: "<Chart />\n" },
				},
			})),
		);

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect(
			(result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({
			code: "unknown-component",
			path: "root > Chart[0]",
			offset: 0,
		})]);
		expect(created).toBe(false);
	});

	it("returns a structured issue for plan syntax that cannot be parsed", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					return { kind: "forbidden" as const };
				},
			},
		});

		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: {
					name: "create_document",
					arguments: { ...creation, plan: "<Callout" },
				},
			})),
		);

		expect((result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues)
			.toEqual([expect.objectContaining({ code: "parse", path: "root" })]);
	});

	it("reports a changed idempotent request as a tool conflict", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					return { kind: "conflict" as const };
				},
			},
		});

		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "create_document", arguments: creation },
			})),
		);

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect((result.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "idempotency-conflict",
		});
	});

	it("advertises the canonical repository and non-blank channel constraints it enforces", () => {
		let list = TOOLS.find(tool => tool.name === "list_documents")!;
		let read = TOOLS.find(tool => tool.name === "read_document")!;
		expect((list.inputSchema.properties as Record<string, { pattern: string }>).repository.pattern)
			.toBe(
				"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}/(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}$",
			);
		expect((read.inputSchema.properties as Record<string, { pattern: string }>).id.pattern).toBe(
			"\\S",
		);
		expect((read.inputSchema.properties as Record<string, { maxLength: number }>).id.maxLength)
			.toBe(128);
	});

	it("does not reveal documents to an unauthenticated caller", async () => {
		let response = await endpoint()(request({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "list_documents", arguments: { repository: "githubnext/chopin" } },
		}, { headers: { authorization: "Bearer denied" } }));

		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain(document.title);
	});

	it("reports parse errors and invalid requests with JSON-RPC errors", async () => {
		let mcp = endpoint();
		let malformed = new Request("https://chopin.test/mcp", {
			method: "POST",
			headers: { authorization: "Bearer allowed", "content-type": "application/json" },
			body: "{",
		});
		expect(await json(await mcp(malformed))).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "parse error" },
		});
		expect(await json(await mcp(request({ jsonrpc: "1.0", id: 4, method: "tools/list" })))).toEqual(
			{
				jsonrpc: "2.0",
				id: 4,
				error: { code: -32600, message: "invalid request" },
			},
		);
	});

	it("rejects declared and streamed request bodies beyond the bounded transport budget", async () => {
		let mcp = endpoint();
		let declared = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "POST",
				headers: {
					authorization: "Bearer allowed",
					"content-length": "786433",
					"content-type": "application/json",
				},
				body: "{}",
			}),
		);
		let streamed = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "POST",
				headers: {
					authorization: "Bearer allowed",
					"content-type": "application/json",
				},
				body: new ReadableStream({
					start(controller) {
						for (let index = 0; index < 7; index++) {
							controller.enqueue(new Uint8Array(131_072));
						}
						controller.close();
					},
				}),
			}),
		);

		for (let response of [declared, streamed]) {
			expect(response.status).toBe(413);
			expect(await response.text()).toBe("request too large");
		}
	});

	it("accepts a document-creation request beyond the former read-only budget", async () => {
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller, input) {
					return {
						kind: "created" as const,
						document: {
							id: "large-plan",
							title: input.title,
							brief: input.brief,
							source: input.plan,
							revision: 0,
							url: "/channels/large-plan",
						},
					};
				},
			},
		});
		let response = await mcp(request({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: {
				name: "create_document",
				arguments: { ...creation, plan: `# Large\n\n${"word ".repeat(14_000)}\n` },
			},
		}));

		expect(response.status).toBe(200);
		expect((await json(response)).error).toBeUndefined();
	});

	it("rejects a UTF-8 canonical plan beyond the source limit before creating it", async () => {
		let created = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create() {
					created = true;
					return { kind: "forbidden" as const };
				},
			},
		});
		let result = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 12,
				method: "tools/call",
				params: {
					name: "create_document",
					arguments: {
						...creation,
						plan: `# ${"😀".repeat(limits.MAX_SOURCE_BYTES / 4)}\n`,
					},
				},
			})),
		);

		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect(
			(result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({ code: "source-too-large", path: "root" })]);
		expect(created).toBe(false);
	});

	it("replays reordered creation values and conflicts on a changed value", async () => {
		let accepted: CreateDocumentInput | undefined;
		let fingerprints: string[] = [];
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			create: {
				async create(_caller, input) {
					fingerprints.push(input.fingerprint);
					let document = {
						id: "replayed",
						title: input.title,
						brief: input.brief,
						source: input.plan,
						revision: 0,
						url: "/channels/replayed",
					};
					if (!accepted) {
						accepted = input;
						return { kind: "created" as const, document };
					}
					return accepted.fingerprint === input.fingerprint
						? { kind: "replayed" as const, document }
						: { kind: "conflict" as const };
				},
			},
		});
		let reordered = {
			plan: creation.plan,
			brief: {
				repositoryFindings: creation.brief.repositoryFindings,
				openQuestions: creation.brief.openQuestions,
				settledDecisions: creation.brief.settledDecisions,
				constraints: creation.brief.constraints,
				goal: creation.brief.goal,
			},
			title: creation.title,
			baseCommit: creation.baseCommit,
			baseBranch: creation.baseBranch,
			repository: creation.repository,
			idempotencyKey: creation.idempotencyKey,
		};

		for (let [id, createArguments] of [[13, creation], [14, reordered]]) {
			let result = await json(
				await mcp(request({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name: "create_document", arguments: createArguments },
				})),
			);
			expect((result.result as { structuredContent: { id: string } }).structuredContent.id)
				.toBe("replayed");
		}

		let changed = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 15,
				method: "tools/call",
				params: {
					name: "create_document",
					arguments: { ...creation, title: "A changed title" },
				},
			})),
		);
		expect((changed.result as { isError: boolean }).isError).toBe(true);
		expect((changed.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "idempotency-conflict",
		});
		expect(fingerprints).toHaveLength(3);
		expect(fingerprints[1]).toBe(fingerprints[0]);
		expect(fingerprints[2]).not.toBe(fingerprints[0]);
	});

	it("does not advertise or dispatch creation from a read-only host", async () => {
		let mcp = handler({ caller: () => "octocat", documents: reader() });
		let tools = await json(
			await mcp(request({ jsonrpc: "2.0", id: 16, method: "tools/list" })),
		);

		expect((tools.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
			.toEqual(["list_documents", "read_document"]);
		let creationAttempt = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 17,
				method: "tools/call",
				params: { name: "create_document", arguments: creation },
			})),
		);
		expect(creationAttempt.error).toEqual({ code: -32601, message: "tool not found" });
	});

	it("rejects non-scalar JSON-RPC ids and scalar initialize or tools-list parameters", async () => {
		let mcp = endpoint();
		for (
			let [request_, id] of [
				[{ jsonrpc: "2.0", id: { invalid: true }, method: "tools/list" }, null],
				[{ jsonrpc: "2.0", id: 5, method: "initialize", params: "invalid" }, 5],
				[{ jsonrpc: "2.0", id: 6, method: "tools/list", params: 1 }, 6],
			]
		) {
			expect(await json(await mcp(request(request_)))).toEqual({
				jsonrpc: "2.0",
				id,
				error: { code: -32600, message: "invalid request" },
			});
		}
	});

	it("rejects malformed tool arguments and unknown tools without consulting the reader", async () => {
		let mcp = endpoint();
		for (
			let [id, name, arguments_, error] of [
				[5, "list_documents", { repository: "./chopin" }, "list_documents requires a repository"],
				[6, "list_documents", { repository: "owner/.." }, "list_documents requires a repository"],
				[7, "read_document", { id: " \t" }, "read_document requires an id"],
				[9, "read_document", { id: "x".repeat(129) }, "read_document requires an id"],
			]
		) {
			let invalid = await json(
				await mcp(request({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name, arguments: arguments_ },
				})),
			);
			expect(invalid.error).toEqual({ code: -32602, message: error });
		}

		let unknown = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { name: "write_document", arguments: {} },
			})),
		);
		expect(unknown.error).toEqual({ code: -32601, message: "tool not found" });
	});

	it("counts read-document ids by JSON Schema characters", async () => {
		let boundary = await json(
			await endpoint()(request({
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: "😀".repeat(128) } },
			})),
		);

		expect(boundary.error).toBeUndefined();
		expect(boundary.result).toEqual({ content: [], isError: true });
	});

	it("returns tool-level absence for a missing or inaccessible channel", async () => {
		let missing = await json(
			await endpoint()(request({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: "missing" } },
			})),
		);
		let inaccessible = await json(
			await handler({
				caller: () => "octocat",
				create: unavailable(),
				documents: {
					async list() {
						return [];
					},
					async read() {
						return undefined;
					},
				},
			})(request({
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: document.id } },
			})),
		);
		expect(missing.result).toEqual({ content: [], isError: true });
		expect(inaccessible.result).toEqual(missing.result);
	});

	it("does not reply to notifications and rejects unknown methods", async () => {
		let mcp = endpoint();
		let notification = await mcp(request({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "list_documents", arguments: { repository: "githubnext/chopin" } },
		}));
		expect(notification.status).toBe(202);
		expect(await notification.text()).toBe("");

		let unknown = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 8,
				method: "resources/list",
			})),
		);
		expect(unknown.error).toEqual({ code: -32601, message: "method not found" });
	});

	it("negotiates authenticated GET event streams and refuses unsupported methods", async () => {
		let mcp = endpoint();
		let stream = await mcp(
			new Request("https://chopin.test/mcp", {
				headers: { authorization: "Bearer allowed", accept: "text/event-stream" },
			}),
		);
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toBe("text/event-stream");

		let unacceptable = await mcp(
			new Request("https://chopin.test/mcp", {
				headers: { authorization: "Bearer allowed", accept: "application/json" },
			}),
		);
		expect(unacceptable.status).toBe(406);

		let unsupported = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "PUT",
				headers: { authorization: "Bearer allowed" },
			}),
		);
		expect(unsupported.status).toBe(405);
		expect(unsupported.headers.get("allow")).toBe("GET, POST");
	});

	it("honors event-stream Accept quality values", async () => {
		let mcp = endpoint();
		for (
			let accept of [
				"text/event-stream;q=0",
				"application/json, text/event-stream; q=0",
				"text/event-stream;q=0, */*;q=1",
				"*/*;q=0",
			]
		) {
			let response = await mcp(
				new Request("https://chopin.test/mcp", {
					headers: { authorization: "Bearer allowed", accept },
				}),
			);
			expect(response.status).toBe(406);
		}

		let accepted = await mcp(
			new Request("https://chopin.test/mcp", {
				headers: { authorization: "Bearer allowed", accept: "text/event-stream;q=0.25" },
			}),
		);
		expect(accepted.status).toBe(200);
	});
});
