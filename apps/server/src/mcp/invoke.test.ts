import { expect, test } from "bun:test";

import { handler, TOOLS } from "../mcp";

import type { InvokePlanner, InvokePlannerInput } from "../mcp";

function endpoint(invoke?: InvokePlanner<string>) {
	return handler({
		caller: () => "octocat",
		documents: { list: async () => [], read: async () => undefined },
		invoke,
	});
}

async function call(mcp: ReturnType<typeof endpoint>, method: string, params?: unknown) {
	let response = await mcp(
		new Request("http://localhost/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
	);
	return response.json();
}

test("invoke_planner is available only with its capability and returns the document URL", async () => {
	let input = {
		id: "/documents/octo-org/score/release",
		instruction: "  Plan this.\n",
		checkout: "/tmp/score",
	};
	let document = {
		id: "document-id",
		title: "Release",
		url: "http://localhost/documents/octo-org/score/release",
	};
	let received: Array<{ caller: string; input: InvokePlannerInput }> = [];
	let mcp = endpoint({
		async invoke(caller, input) {
			received.push({ caller, input });
			return { kind: "invoked", document };
		},
	});
	let tool = TOOLS.find(tool => tool.name === "invoke_planner");
	expect(tool).toBeDefined();
	expect((await call(endpoint(), "tools/list")).result.tools).not.toContainEqual(tool);
	expect(
		(await call(endpoint(), "tools/call", { name: "invoke_planner", arguments: input })).error.code,
	).toBe(-32601);
	expect((await call(mcp, "tools/list")).result.tools).toContainEqual(tool);
	expect((await call(mcp, "initialize", {})).result.instructions).toContain("invoke_planner:");
	let result = await call(mcp, "tools/call", { name: "invoke_planner", arguments: input });
	expect(result.result.structuredContent).toEqual(document);
	expect(received).toEqual([{ caller: "octocat", input }]);
});

test("invoke_planner validates strict arguments and counts instruction bytes without rewriting text", async () => {
	let received: InvokePlannerInput[] = [];
	let mcp = endpoint({
		async invoke(_caller, input) {
			received.push(input);
			return { kind: "invoked", document: { id: input.id, title: "Document", url: "/document" } };
		},
	});
	let valid = { id: "document-id", instruction: "go" };
	for (
		let args of [
			{},
			{ ...valid, id: " " },
			{ ...valid, instruction: " \n\t" },
			{ ...valid, instruction: "a".repeat(65_537) },
			{ ...valid, instruction: "é".repeat(32_769) },
			{ ...valid, instruction: 3 },
			{ ...valid, checkout: "relative/path" },
			{ ...valid, checkout: null },
			{ ...valid, checkout: "" },
			{ ...valid, extra: true },
		]
	) {
		let result = await call(mcp, "tools/call", { name: "invoke_planner", arguments: args });
		expect(result.error.code).toBe(-32602);
	}
	expect(received).toEqual([]);
	let exact = { ...valid, instruction: "é".repeat(32_768) };
	expect(
		(await call(mcp, "tools/call", { name: "invoke_planner", arguments: exact })).result.isError,
	).toBeUndefined();
	expect(received).toEqual([exact]);
});

test("invoke_planner exposes each refusal as an object code", async () => {
	for (
		let code of [
			"document-unavailable",
			"repository-forbidden",
			"document-archived",
			"planner-owner-unavailable",
			"checkout-unverified",
			"planner-unavailable",
			"planner-queue-full",
		] as const
	) {
		let mcp = endpoint({ invoke: async () => ({ kind: "refused", code }) });
		let result = await call(mcp, "tools/call", {
			name: "invoke_planner",
			arguments: { id: "document-id", instruction: "go" },
		});
		expect(result.result).toMatchObject({ isError: true, structuredContent: { code } });
	}
});
