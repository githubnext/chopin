import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "../mcp";

import type { DocumentReader, RenameDocument } from "../mcp";

const id = "f401c8d6-3717-4f1d-8473-cfdd0af894e4";

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
		async list() {
			return [];
		},
		async read() {
			return undefined;
		},
	};
}

function call(arguments_: Record<string, unknown>): Request {
	return request({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "rename_document", arguments: arguments_ },
	});
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

describe("the MCP rename protocol", () => {
	it("canonicalizes and renames a document through the host adapter", async () => {
		let received: unknown;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			rename: {
				async rename(caller, input) {
					received = { caller, input };
					return {
						kind: "renamed" as const,
						document: { id: input.id, title: input.title },
					};
				},
			},
		});
		let tools = await json(await mcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
		expect((tools.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
			.toContain("rename_document");

		let response = await json(await mcp(call({ id, title: "  Launch plan  " })));

		expect(received).toEqual({ caller: "octocat", input: { id, title: "Launch plan" } });
		expect((response.result as { structuredContent: unknown }).structuredContent).toEqual({
			id,
			title: "Launch plan",
		});
	});

	it("rejects malformed rename arguments before consulting the host", async () => {
		let called = false;
		let rename: RenameDocument<string> = {
			async rename() {
				called = true;
				return { kind: "unavailable" };
			},
		};
		let mcp = handler({ caller: () => "octocat", documents: reader(), rename });

		for (
			let arguments_ of [
				{ id, title: " " },
				{ id: " ", title: "Launch plan" },
				{ id, title: "x".repeat(121) },
				{ id, title: "Launch plan", extra: true },
			]
		) {
			let response = await json(await mcp(call(arguments_)));
			expect(response.error).toEqual({
				code: -32602,
				message: "rename_document requires an id and valid title",
			});
		}
		expect(called).toBe(false);
	});

	it("returns stable tool errors for rename failures", async () => {
		let tool = TOOLS.find(tool => tool.name === "rename_document")!;
		expect(tool.outputSchema).toEqual(expect.objectContaining({
			oneOf: expect.arrayContaining([
				expect.objectContaining({
					properties: { code: expect.objectContaining({ type: "string" }) },
				}),
			]),
		}));
		for (
			let [kind, code] of [
				["archived", "document-archived"],
				["conflict", "title-conflict"],
				["forbidden", "repository-forbidden"],
				["unavailable", "document-unavailable"],
			] as const
		) {
			let mcp = handler({
				caller: () => "octocat",
				documents: reader(),
				rename: {
					async rename() {
						return { kind };
					},
				},
			});
			let response = await json(await mcp(call({ id, title: "Launch plan" })));
			expect((response.result as { structuredContent: unknown }).structuredContent).toEqual({
				code,
			});
			expect((response.result as { isError: boolean }).isError).toBe(true);
		}
	});
});
