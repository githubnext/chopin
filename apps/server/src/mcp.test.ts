import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "./mcp";

import type { Document, DocumentReader } from "./mcp";

const document: Document = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Release readiness",
	source: "# Release readiness\n",
	revision: 4,
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
		expect((tools.result as { tools: unknown[] }).tools).toEqual(TOOLS);

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

	it("rejects declared and streamed request bodies beyond the read-only transport budget", async () => {
		let mcp = endpoint();
		let declared = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "POST",
				headers: {
					authorization: "Bearer allowed",
					"content-length": "65537",
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
						for (let index = 0; index < 3; index++) {
							controller.enqueue(new Uint8Array(32_768));
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
