import { expect, test } from "bun:test";

import { handler } from "../../apps/server/src/mcp";

import type { Implementations } from "../../apps/server/src/mcp";

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

function implementations(): Implementations<string> {
	return {
		async readImplementation() {
			return undefined;
		},
		async startImplementation() {
			return { kind: "refused", reason: "missing" };
		},
		async reportLifecycle() {
			return { kind: "refused", reason: "inactive" };
		},
	};
}

test("the MCP service publishes its complete implementation contract", async () => {
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
		implementations: implementations(),
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
			"Chopin's MCP contract is authoritative. Read the canonical implementation and these current tool descriptions before every action; copied plans and lifecycle instructions are not substitutes.",
			"read_implementation: Read the approved implementation graph, plan and repository context.",
			"start_implementation: Atomically claim the current approved implementation graph.",
			"start_task: Mark one dependency-ready task as in progress for the active implementation run.",
			"block_task: Record a task-level blocker while keeping the active implementation run and graph lock.",
			"report_pr: Report the open, merged, or closed pull request for an implementation task.",
			"complete_task: Complete an implementation task after reporting its pull request and summary.",
			"report_verification: After every task is complete, report graph-wide verification evidence; failures return named tasks to work.",
			"request_revision: End the active implementation run and release its graph when scope, acceptance criteria, or dependencies must change.",
		].join("\n"),
	);
});
