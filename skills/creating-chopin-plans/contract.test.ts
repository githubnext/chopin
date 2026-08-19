import { expect, test } from "bun:test";

import { handler } from "../../apps/server/src/mcp";

import type { CreateDocument } from "../../apps/server/src/mcp";

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

function creation(): CreateDocument<string> {
	return {
		async create() {
			return { kind: "forbidden" };
		},
	};
}

test("the MCP service publishes its creation contract without implementation guidance", async () => {
	let mcp = handler({
		caller: () => "operator",
		documents: {
			async list() {
				return [];
			},
			async read() {
				return undefined;
			},
		},
		create: creation(),
	});
	let initialized = await mcp(request({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {},
	}));
	let initialization = await initialized.json() as {
		result: { instructions?: string };
	};
	expect(initialization.result.instructions).toBe(
		[
			"Chopin's MCP contract and current tool descriptions are authoritative.",
			"create_document: Create a Chopin document from a structured brief and canonical plan.",
		].join("\n"),
	);
});
