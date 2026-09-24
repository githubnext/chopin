import { content, expect, test } from "./room";

async function mcp(baseURL: string, body: unknown, session?: string): Promise<Response> {
	let response = await fetch(`${baseURL}/mcp`, {
		method: "POST",
		headers: {
			authorization: "Bearer ghu_e2e_ana_1",
			"content-type": "application/json",
			...(session ? { "mcp-session-id": session } : {}),
		},
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
	return response;
}

test("a live MCP rewrite appears in the editor with change marks", async ({ baseURL, join, room, seed }) => {
	await seed("# Title\n\nOriginal paragraph.\n");
	let page = await join("ana");
	await expect(content(page)).toContainText("Original paragraph.");

	let read = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "read_document", arguments: { id: room } },
	})).json();
	let current = read.result.structuredContent;
	let arguments_ = {
		id: room,
		revision: current.revision,
		plan: "# Title\n\nRevised paragraph.\n",
		idempotencyKey: "e2e-update-1",
	};
	let updated = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "update_document", arguments: arguments_ },
	})).json();
	expect(updated.result.structuredContent.source).toContain("Revised paragraph.");
	await expect(content(page)).toContainText("Revised paragraph.");
	await expect(page.locator("[data-plan-change='added']")).toBeVisible();
	await expect(page.getByRole("region", { name: "Document" }).getByText("chopin", { exact: true }))
		.toHaveCount(0);

	let conflict = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: {
			name: "update_document",
			arguments: { ...arguments_, idempotencyKey: "stale", plan: "# Stale\n" },
		},
	})).json();
	expect(conflict.result.structuredContent).toEqual({
		code: "revision-conflict",
		revision: current.revision + 1,
	});
	await page.reload();
	await expect(content(page)).toContainText("Revised paragraph.");
	let replay = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "update_document", arguments: arguments_ },
	})).json();
	expect(replay.result.structuredContent).toEqual(updated.result.structuredContent);
});

test("MCP changes identify the client and revision transition in the change list", async ({ baseURL, join, room, seed }) => {
	let source = "# Title\n\n"
		+ Array.from({ length: 40 }, (_, i) => `Unchanged paragraph ${i}.\n\n`).join("")
		+ "Original ending.\n";
	await seed(source);
	let page = await join("ana");
	await expect(content(page)).toContainText("Original ending.");
	let initialized = await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { clientInfo: { name: "Review bot", version: "1.2.3" } },
	});
	let session = initialized.headers.get("mcp-session-id")!;
	let read = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "read_document", arguments: { id: room } },
	}, session)).json();
	let revision = read.result.structuredContent.revision;
	let updated = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: {
			name: "update_document",
			arguments: {
				id: room,
				revision,
				plan: source.replace("Original ending.", "Revised ending."),
				idempotencyKey: "attributed-update",
			},
		},
	}, session)).json();
	expect(updated.result.isError).toBeUndefined();
	await expect(content(page)).toContainText("Revised ending.");
	await page.getByRole("button", { name: "What the agent changed", exact: true }).click();
	let label = page.getByText("Written by Review bot", { exact: true });
	await expect(label).toBeVisible();
	await expect(label).toHaveAttribute(
		"title",
		`Review bot 1.2.3, revisions ${revision} to ${revision + 1}`,
	);
});
