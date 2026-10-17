import { createHash } from "node:crypto";

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
	let label = page.getByText("Written by @ana via Review bot", { exact: true });
	await expect(label).toBeVisible();
	await expect(label).toHaveAttribute(
		"title",
		`Review bot 1.2.3, revisions ${revision} to ${revision + 1}`,
	);
});

test("an MCP rewrite of other prose keeps a linked decision's way to the document", async ({ baseURL, join, room, seed }) => {
	let widget = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
	let question = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
	let option = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let linked = "We roll out with a canary.";
	let source = `# Title\n\n${linked}\n\nOther paragraph.\n\n`
		+ `<Questionnaire id="${widget}" by="ana" at="2026-09-23T15:13:00.000Z">\n`
		+ `<Question id="${question}" header="Rollout" prompt="How should we deploy?" multiple="false">\n`
		+ `<Option id="${option}" label="Canary" />\n<Answer value="Canary" />\n`
		+ `</Question>\n</Questionnaire>\n`;
	let digest = `sha256:${createHash("sha256").update(`${linked}\n`).digest("hex")}`;
	await seed(source, {
		revision: 1,
		questions: [{
			id: widget,
			status: "answered",
			definition: {
				questions: [{
					id: question,
					header: "Rollout",
					question: "How should we deploy?",
					multiple: false,
					options: [{ id: option, label: "Canary", description: "" }],
				}],
			},
			answers: { [question]: "Canary" },
			resolver: "ana",
			anchors: {
				widget,
				questions: {
					[question]: { anchors: [{ epoch: "stale", position: "", digest }], pending: false },
				},
			},
		}],
	});
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = page.locator(
		`[data-document-view="decisions"] [data-plan-sidecar-questionnaire="${widget}"]`,
	);
	await expect(card.getByRole("button", { name: "Show in document" })).toBeVisible();

	let read = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "read_document", arguments: { id: room } },
	})).json();
	let current = read.result.structuredContent;
	let updated = await (await mcp(baseURL!, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "update_document",
			arguments: {
				id: room,
				revision: current.revision,
				plan: current.source.replace("Other paragraph.", "Other paragraph, revised."),
				idempotencyKey: "e2e-keep-link",
			},
		},
	})).json();
	expect(updated.result.isError).toBeUndefined();
	await page.getByRole("button", { name: /^Document(?:,|$)/ }).click();
	await expect(content(page)).toContainText("Other paragraph, revised.");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(card.getByRole("button", { name: "Show in document" })).toBeVisible();
	await expect(card.locator("[data-relation]")).toHaveAttribute("data-relation", "linked");
	await page.reload();
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(card.getByRole("button", { name: "Show in document" })).toBeVisible();
});
