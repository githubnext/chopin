import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "../mcp";

import type { ArchiveDocument, DocumentReader, RestoreDocument } from "../mcp";

let id = "f401c8d6-3717-4f1d-8473-cfdd0af894e4";
let url = "/documents/githubnext/chopin/release-readiness";
let archivedAt = "2026-08-23T12:34:56.000Z";

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

function call(name: string, arguments_: Record<string, unknown>): Request {
	return request({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: arguments_ },
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

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

describe("the MCP archive protocol", () => {
	it("archives and restores document locators with strict public schemas", async () => {
		let received: Array<{ action: string; caller: string; id: string }> = [];
		let archive: ArchiveDocument<string> = {
			async archive(caller, locator) {
				received.push({ action: "archive", caller, id: locator });
				return {
					kind: "archived",
					document: { id, title: "Release readiness", archivedAt },
				};
			},
		};
		let restore: RestoreDocument<string> = {
			async restore(caller, locator) {
				received.push({ action: "restore", caller, id: locator });
				return { kind: "restored", document: { id, title: "Release readiness" } };
			},
		};
		let mcp = handler({ caller: () => "octocat", documents: reader(), archive, restore });
		let initialized = await json(
			await mcp(request({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })),
		);
		expect((initialized.result as { instructions: string }).instructions).toContain(
			"archive_document: Archive a Chopin document by ID or canonical URL.",
		);
		expect((initialized.result as { instructions: string }).instructions).toContain(
			"restore_document: Restore an archived Chopin document by ID or canonical URL.",
		);
		let listed = await json(
			await mcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
		);
		let names = (listed.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
		expect(names).toContain("archive_document");
		expect(names).toContain("restore_document");
		expect(names).not.toContain("delete_document");

		let archived = await json(await mcp(call("archive_document", { id: url })));
		let restored = await json(await mcp(call("restore_document", { id })));
		expect((archived.result as { structuredContent: unknown }).structuredContent).toEqual({
			id,
			title: "Release readiness",
			archivedAt,
		});
		expect((restored.result as { structuredContent: unknown }).structuredContent).toEqual({
			id,
			title: "Release readiness",
		});
		expect(received).toEqual([
			{ action: "archive", caller: "octocat", id: url },
			{ action: "restore", caller: "octocat", id },
		]);

		let archiveSchema = TOOLS.find(tool => tool.name === "archive_document")!.outputSchema as {
			oneOf: Array<Record<string, unknown>>;
		};
		let restoreSchema = TOOLS.find(tool => tool.name === "restore_document")!.outputSchema as {
			oneOf: Array<Record<string, unknown>>;
		};
		expect(archiveSchema.oneOf[0]).toMatchObject({
			required: ["id", "title", "archivedAt"],
			additionalProperties: false,
		});
		expect(restoreSchema.oneOf[0]).toMatchObject({
			required: ["id", "title"],
			additionalProperties: false,
		});
	});

	it("validates locators and maps stable transition failures", async () => {
		let called = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			archive: {
				async archive(_caller, locator) {
					called = true;
					return { kind: locator === "forbidden" ? "forbidden" : "unavailable" };
				},
			},
			restore: {
				async restore() {
					return { kind: "unavailable" };
				},
			},
		});
		for (
			let [name, arguments_] of [
				["archive_document", { id: " " }],
				["archive_document", { id, extra: true }],
				["restore_document", { id: "x".repeat(2_049) }],
			] as const
		) {
			let response = await json(await mcp(call(name, arguments_)));
			expect(response).toMatchObject({ error: { code: -32602 } });
		}
		expect(called).toBe(false);

		let forbidden = await json(await mcp(call("archive_document", { id: "forbidden" })));
		let unavailable = await json(await mcp(call("archive_document", { id: "missing" })));
		let restoreUnavailable = await json(await mcp(call("restore_document", { id })));
		expect((forbidden.result as { structuredContent: unknown }).structuredContent).toEqual({
			code: "repository-forbidden",
		});
		for (let response of [unavailable, restoreUnavailable]) {
			expect((response.result as { structuredContent: unknown }).structuredContent).toEqual({
				code: "document-unavailable",
			});
			expect((response.result as { isError: boolean }).isError).toBe(true);
		}
	});
});
