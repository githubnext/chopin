import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "../mcp";

import type { Document, DocumentReader } from "../mcp";

const document: Document = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Release readiness",
	description: "Plan for release readiness",
	source: "# Release readiness\n",
	revision: 4,
};

function request(body: unknown): Request {
	return new Request("https://chopin.test/mcp", {
		method: "POST",
		headers: {
			authorization: "Bearer allowed",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function reader(): DocumentReader<string> {
	return {
		async list(caller, repository) {
			return caller === "octocat" && repository === "githubnext/chopin"
				? [{ id: document.id, title: document.title, description: document.description }]
				: [];
		},
		async read(caller, id) {
			return caller === "octocat" && id === document.id ? document : undefined;
		},
	};
}

function endpoint(documents = reader()) {
	return handler({
		caller: request =>
			request.headers.get("authorization") === "Bearer allowed"
				? "octocat"
				: undefined,
		documents,
	});
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

describe("the MCP document protocol", () => {
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
			documents: [{
				id: document.id,
				title: document.title,
				description: document.description,
			}],
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

	it("reports a repository denial instead of an empty document list", async () => {
		let result = await json(
			await endpoint({
				async list() {
					return "forbidden";
				},
				async read() {
					return undefined;
				},
			})(request({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "list_documents", arguments: { repository: "githubnext/chopin" } },
			})),
		);

		expect(result.result).toEqual({
			content: [{ type: "text", text: '{"code":"repository-forbidden"}' }],
			isError: true,
			structuredContent: { code: "repository-forbidden" },
		});
	});

	it("defaults archived listing off and exposes archival metadata when requested", async () => {
		let archivedAt = "2026-08-23T12:34:56.000Z";
		let includeArchived: boolean[] = [];
		let archived = { ...document, archivedAt };
		let mcp = endpoint({
			async list(_caller, _repository, include = false) {
				includeArchived.push(include);
				return include
					? [{
						id: document.id,
						title: document.title,
						description: document.description,
						archivedAt,
					}]
					: [];
			},
			async read() {
				return archived;
			},
		});
		let calls = [
			{ repository: "githubnext/chopin" },
			{ repository: "githubnext/chopin", includeArchived: true },
		];
		let listed = [];
		for (let [index, arguments_] of calls.entries()) {
			let response = await json(
				await mcp(request({
					jsonrpc: "2.0",
					id: index + 10,
					method: "tools/call",
					params: { name: "list_documents", arguments: arguments_ },
				})),
			);
			listed.push((response.result as { structuredContent: unknown }).structuredContent);
		}

		expect(includeArchived).toEqual([false, true]);
		expect(listed).toEqual([{ documents: [] }, {
			documents: [{
				id: document.id,
				title: document.title,
				description: document.description,
				archivedAt,
			}],
		}]);

		let read = await json(
			await mcp(request({
				jsonrpc: "2.0",
				id: 12,
				method: "tools/call",
				params: { name: "read_document", arguments: { id: document.id } },
			})),
		);
		expect((read.result as { structuredContent: unknown }).structuredContent).toEqual(archived);
		expect(
			((TOOLS.find(tool => tool.name === "list_documents")!.inputSchema.properties) as Record<
				string,
				unknown
			>).includeArchived,
		).toEqual({ type: "boolean", default: false });
	});
});
