import { afterEach, expect, test } from "bun:test";

import { handler, TOOLS } from "../mcp";
import { rooted } from "../testing/rooted";
import { invokeRouted } from "./invoke";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

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
			"planner-not-attached",
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

test("invoke_planner carries a refusal's message beside its code", async () => {
	let message = "No Planner is attached to this document. Connect a Planner client to attach one.";
	let mcp = endpoint({
		invoke: async () => ({ kind: "refused", code: "planner-not-attached", message }),
	});
	let result = await call(mcp, "tools/call", {
		name: "invoke_planner",
		arguments: { id: "document-id", instruction: "go" },
	});
	expect(result.result).toMatchObject({
		isError: true,
		structuredContent: { code: "planner-not-attached", message },
	});
	expect(JSON.parse(result.result.content[0].text)).toEqual({
		code: "planner-not-attached",
		message,
	});
});

/** A root and child, with `invokePlanner` routed as `main.ts` routes it. */
async function routed() {
	let fixture = await rooted({ root: "# Root\n\nRoot prose.\n", child: "# Child\n\nFinding.\n" });
	cleanups.push(fixture.close);
	let opened: string[] = [];
	let released = 0;
	let route = {
		channels: fixture.storage.channels,
		deleting: () => false,
		transition: <T>(_id: string, action: () => Promise<T>) => action(),
		open: async (rootId: string) => {
			opened.push(rootId);
			if (rootId !== fixture.root.channel.id) throw new Error(`unexpected room ${rootId}`);
			return { context: fixture.root.context, release: () => released++ };
		},
	};
	let invoke = async (channelId: string, repositoryId = fixture.repository.id) => {
		let channel = (await fixture.storage.channels.get(channelId))!;
		return invokeRouted(route, {
			channel,
			repository: {
				...fixture.repository,
				id: repositoryId,
				permissions: { push: true, pull: true, admin: false },
			},
			user: { id: fixture.user.id, login: fixture.user.login, avatarUrl: "" },
			instruction: "Summarize the open findings.",
		} as never);
	};
	return { ...fixture, invoke, opened, released: () => released };
}

test("invoke_planner on a child posts to the root's Chat with the child as focus", async () => {
	let { child, invoke, opened, root, turns } = await routed();
	expect(await invoke(child.channel.id)).toBeUndefined();
	await turns.started();
	expect(opened).toEqual([root.channel.id]);
	expect(root.plan.chat.entries.at(-1)).toMatchObject({
		author: { kind: "member", handle: "ana" },
		text: "Summarize the open findings.",
	});
	expect(child.plan.chat.entries).toEqual([]);
	expect(child.plan.chat.busy).toBe(false);
	expect(turns.prompts.at(-1)).toContain(`child id ${child.channel.id}`);
});

test("invoke_planner on a root runs on its own Chat without a focus", async () => {
	let { invoke, root, turns } = await routed();
	expect(await invoke(root.channel.id)).toBeUndefined();
	await turns.started();
	expect(turns.prompts.at(-1)).not.toContain("child id");
});

test("invoke_planner on a child that no longer belongs to its root fails closed", async () => {
	let { child, invoke, opened, released, root, storage } = await routed();
	await storage.channels.archive({ id: root.channel.id, now: new Date() });
	expect(await invoke(child.channel.id)).toBe("document-archived");
	await storage.channels.restore({ id: root.channel.id, now: new Date() });
	// The caller's located repository is not the root's: ChildDocuments refuses it.
	expect(await invoke(child.channel.id, "R_other")).toBe("document-unavailable");
	expect(root.plan.chat.entries).toEqual([]);
	expect(child.plan.chat.entries).toEqual([]);
	expect(released()).toBe(opened.length);
});
