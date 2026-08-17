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

	it("rejects malformed tool arguments and unknown tools without consulting the reader", async () => {
		let mcp = endpoint();
		let invalid = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "list_documents", arguments: { repository: "./chopin" } },
			})),
		);
		expect(invalid.error).toEqual({
			code: -32602,
			message: "list_documents requires a repository",
		});

		let unknown = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { name: "write_document", arguments: {} },
			})),
		);
		expect(unknown.error).toEqual({ code: -32601, message: "tool not found" });
	});

	it("returns tool-level absence for a missing or inaccessible channel", async () => {
		let response = await json(
			await endpoint()(request({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: "missing" } },
			})),
		);
		expect(response.result).toEqual({ content: [], isError: true });
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
});
