import { describe, expect, test } from "bun:test";

import { create } from "../chat/service";
import { JOB_TOOLS, refusal, runJobTool, WRITE_TOOLS } from "./job-scope";

import type { ConversationPlan } from "@chopin/protocol";

const JOB: ConversationPlan.Job = {
	id: "refine:W1:m1",
	kind: "refine",
	target: "W1",
	trigger: "m1",
	status: "running",
	attempts: 0,
	at: "2026-09-25T10:00:00.000Z",
};

describe("background Planner job scope", () => {
	test("ordinary turns may write normally but cannot call a job tool", () => {
		expect(JOB_TOOLS).toEqual({
			heading: "draft_heading",
			refine: "refine_decision",
			suggest: "refine_decision",
			prose: "write_decision_prose",
		});
		expect(WRITE_TOOLS.has("create_research_workspace")).toBe(true);
		expect(WRITE_TOOLS.has("revise_open_decision")).toBe(true);
		expect(refusal(undefined, "read_plan")).toBeUndefined();
		expect(refusal(undefined, "edit_plan")).toBeUndefined();
		expect(refusal(undefined, "refine_decision")).toBe(
			"refine_decision is only available to a background Planner job.",
		);
	});

	test("a job can read and use exactly its own writing tool", () => {
		expect(refusal(JOB, "read_plan")).toBeUndefined();
		expect(refusal(JOB, "refine_decision")).toBeUndefined();
		for (
			let name of [
				"edit_plan",
				"ask",
				"anchor_plan",
				"reply_comment",
				"edit_implementation_graph",
				"create_research_workspace",
				"revise_open_decision",
				"draft_heading",
				"write_decision_prose",
			]
		) {
			expect(refusal(JOB, name)).toBe(
				`This is a background refine job; use only refine_decision. ${name} is not available.`,
			);
		}
	});
});

describe("runJobTool", () => {
	test("records one bounded JSON output for the current running job", async () => {
		let chat = create();
		chat.job = { ...JOB };
		let current = chat.job;
		let result = await runJobTool(chat, "refine_decision", async job => {
			expect(job).toBe(current);
			return { output: { added: 2 }, skipped: ["duplicate"] };
		});
		expect(result).toEqual({ ok: true, added: 2, skipped: ["duplicate"] });
		expect(chat.jobOutput).toBe(JSON.stringify({ added: 2 }));
	});

	test("refuses absent, inactive, foreign, and read-only tool calls before producing", async () => {
		let chat = create();
		let calls = 0;
		let produce = async () => {
			calls++;
			return { output: {} };
		};
		await expect(runJobTool(chat, "refine_decision", produce)).rejects.toThrow(
			"only available to a background Planner job",
		);
		chat.job = { ...JOB, status: "failed" };
		await expect(runJobTool(chat, "refine_decision", produce)).rejects.toThrow(
			"running background Planner job",
		);
		chat.job = { ...JOB };
		await expect(runJobTool(chat, "draft_heading", produce)).rejects.toThrow(
			"use only refine_decision",
		);
		await expect(runJobTool(chat, "read_plan", produce)).rejects.toThrow(
			"only its own tool",
		);
		expect(calls).toBe(0);
		expect(chat.jobOutput).toBeUndefined();
	});

	test("an awaited tool cannot record success for a replacement job", async () => {
		let chat = create();
		chat.job = { ...JOB };
		let gate = Promise.withResolvers<void>();
		let operation = runJobTool(chat, "refine_decision", async () => {
			await gate.promise;
			return { output: { added: 1 } };
		});
		chat.job = { ...JOB, id: "refine:W2:m2", target: "W2", trigger: "m2" };
		gate.resolve();
		await expect(operation).rejects.toThrow("background Planner job changed");
		expect(chat.jobOutput).toBeUndefined();
	});

	test("an awaited tool cannot record success for a replacement turn", async () => {
		let chat = create();
		chat.job = { ...JOB };
		chat.turn = { id: "turn-1", handle: "chopin", started: 1, entryOffset: 0, responded: false };
		let gate = Promise.withResolvers<void>();
		let operation = runJobTool(chat, "refine_decision", async () => {
			await gate.promise;
			return { output: { added: 1 } };
		});
		chat.turn = { id: "turn-2", handle: "chopin", started: 2, entryOffset: 0, responded: false };
		gate.resolve();
		await expect(operation).rejects.toThrow("background Planner job changed");
		expect(chat.jobOutput).toBeUndefined();
	});

	test("rejects output that cannot be stored as a bounded JSON summary", async () => {
		let chat = create();
		chat.job = { ...JOB };
		await expect(runJobTool(chat, "refine_decision", async () => ({ output: undefined })))
			.rejects.toThrow("valid JSON");
		await expect(runJobTool(chat, "refine_decision", async () => ({
			output: { detail: "x".repeat(4_096) },
		}))).rejects.toThrow("4096");
		expect(chat.jobOutput).toBeUndefined();
	});
});
