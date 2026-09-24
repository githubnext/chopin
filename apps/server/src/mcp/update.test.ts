import { describe, expect, it } from "bun:test";

import { handler, TOOLS } from "../mcp";
import { prepareUpdate } from "./update";

import type { Document, DocumentReader, UpdateDocumentInput } from "../mcp";

let document: Document = {
	id: "f401c8d6-3717-4f1d-8473-cfdd0af894e4",
	title: "Release readiness",
	source: "# Release readiness\n",
	revision: 4,
};

let update = {
	id: document.id,
	revision: 4,
	plan: "# Revised\n\nUpdated prose.\n",
	idempotencyKey: "update-plan-1",
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
		async list() {
			return [];
		},
		async read(_caller, id) {
			return id === document.id ? document : undefined;
		},
	};
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

function call(id: number, arguments_: Record<string, unknown>): Request {
	return request({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "update_document", arguments: arguments_ },
	});
}

describe("the MCP update protocol", () => {
	it("advertises a typed object output schema and updates through the host", async () => {
		let received: UpdateDocumentInput | undefined;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			update: {
				async update(_caller, input) {
					received = input;
					return {
						kind: "updated" as const,
						document: {
							id: input.id,
							title: "Release readiness",
							source: input.plan,
							revision: input.revision + 1,
							url: "/documents/githubnext/chopin/release-readiness",
						},
					};
				},
			},
		});
		let tool = TOOLS.find(entry => entry.name === "update_document")!;
		expect(tool.outputSchema.type).toBe("object");
		expect(tool.outputSchema.oneOf).toEqual(expect.any(Array));

		let result = await json(await mcp(call(1, update)));
		expect(result.error).toBeUndefined();
		expect((result.result as { structuredContent: unknown }).structuredContent).toMatchObject({
			id: document.id,
			revision: 5,
			url: "/documents/githubnext/chopin/release-readiness",
		});
		expect(received?.idempotencyKey).toBe(update.idempotencyKey);
		expect(received?.fingerprint).toHaveLength(64);
	});

	it("returns dialect issues without asking the host to persist", async () => {
		let called = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			update: {
				async update() {
					called = true;
					return { kind: "forbidden" as const };
				},
			},
		});
		let result = await json(await mcp(call(2, { ...update, plan: "<Chart />\n" })));
		expect((result.result as { isError: boolean }).isError).toBe(true);
		expect(
			(result.result as { structuredContent: { issues: unknown[] } }).structuredContent.issues,
		).toEqual([expect.objectContaining({ code: "unknown-component" })]);
		expect(called).toBe(false);
	});

	it("returns structured conflict codes from the host", async () => {
		for (
			let [kind, body] of [
				["conflict", { code: "idempotency-conflict" }],
				["locked", { code: "document-locked" }],
				["protected", { code: "protected-projection" }],
				["archived", { code: "document-archived" }],
				["forbidden", { code: "repository-forbidden" }],
				["unavailable", { code: "document-unavailable" }],
			] as const
		) {
			let mcp = handler({
				caller: () => "octocat",
				documents: reader(),
				update: {
					async update() {
						return { kind };
					},
				},
			});
			let result = await json(await mcp(call(3, update)));
			expect((result.result as { structuredContent: unknown }).structuredContent).toEqual(body);
		}

		let conflict = handler({
			caller: () => "octocat",
			documents: reader(),
			update: {
				async update() {
					return { kind: "revision-conflict" as const, revision: 9 };
				},
			},
		});
		expect((await json(await conflict(call(4, update)))).result).toMatchObject({
			structuredContent: { code: "revision-conflict", revision: 9 },
		});
	});

	it("rejects malformed update arguments before consulting the host", async () => {
		let called = false;
		let mcp = handler({
			caller: () => "octocat",
			documents: reader(),
			update: {
				async update() {
					called = true;
					return { kind: "unavailable" };
				},
			},
		});
		for (
			let arguments_ of [
				{ ...update, revision: -1 },
				{ ...update, revision: 1.5 },
				{ ...update, revision: "4" },
				{ ...update, revision: Number.MAX_SAFE_INTEGER + 1 },
				{ ...update, id: " " },
				{ ...update, id: "x".repeat(2049) },
				{ ...update, idempotencyKey: "x".repeat(129) },
				{ ...update, plan: " " },
				{ ...update, idempotencyKey: "" },
				{ ...update, extra: true },
				{ id: update.id, revision: 4, plan: update.plan },
			]
		) {
			let result = await json(await mcp(call(5, arguments_)));
			expect(result.error).toEqual({
				code: -32602,
				message: "update_document requires a valid revision and plan",
			});
		}
		expect(called).toBe(false);
	});

	it("mints component ids without changing the retry fingerprint", () => {
		let input = { ...update, plan: '<Callout type="note">\nA note.\n</Callout>\n' };
		let first = prepareUpdate(input);
		let second = prepareUpdate(input);
		if (!first || !("input" in first) || !second || !("input" in second)) {
			throw new Error("valid callout was rejected");
		}
		expect(first.input.plan).toMatch(/<Callout id="[A-Z0-9]{26}"/);
		expect(first.input.fingerprint).toBe(second.input.fingerprint);
	});

	it("accepts canonical URLs and advertises the optional creation brief", () => {
		let prepared = prepareUpdate({
			...update,
			id: "https://chopin.test/documents/githubnext/chopin/release-readiness",
		});
		expect(prepared).toHaveProperty("input");
		let tool = TOOLS.find(entry => entry.name === "update_document")!;
		let variants = tool.outputSchema.oneOf as Array<{ properties: Record<string, unknown> }>;
		expect(variants[0]!.properties).toHaveProperty("brief");
	});

	it("does not advertise update from a host that cannot rewrite documents", async () => {
		let mcp = handler({ caller: () => "octocat", documents: reader() });
		let tools = await json(
			await mcp(request({ jsonrpc: "2.0", id: 6, method: "tools/list" })),
		);
		expect((tools.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
			.not.toContain("update_document");
	});
});
