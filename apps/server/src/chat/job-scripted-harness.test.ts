import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import { HEADING_TOOL_NAMES } from "../harness/tool-names";
import { scriptedHeading } from "./job-scripted-harness.test-fixtures";

let HEADING = {
	tool: "draft_heading",
	args: { revision: "$revision", title: "Auth Strategy", goal: "Goal: pick auth." },
};
let SOURCE = "# Auth Strategy\n\nGoal: pick auth.\n";

test("a script runs through current Harness and commits the real heading before its result", async () => {
	let h = await scriptedHeading([HEADING]);
	let observed = false;
	try {
		h.onResult(async output => {
			expect(String(output)).toContain('"ok": true');
			expect(await h.savedSource()).toBe(SOURCE);
			expect(h.opened.plan.chat.job?.kind).toBe("heading");
			observed = true;
		});
		expect(await h.run()).toEqual({
			status: "done",
			output: JSON.stringify({ title: "Auth Strategy", goal: "Goal: pick auth." }),
		});
		expect(observed).toBe(true);
		expect(h.plannerSessionId()).toBeDefined();
		expect(h.setupRequests).toEqual([{
			command: 'mkdir -p "$WORK_DIR"',
			directory: `/tmp/${encodeURIComponent(h.driver.fake.harnessId)}-${
				encodeURIComponent(h.plannerSessionId()!)
			}`,
		}]);
		expect(h.driver.tools).toEqual([[...HEADING_TOOL_NAMES]]);
		expect(h.driver.calls.map(call => call.toolName)).toEqual(["draft_heading"]);
		expect(h.driver.results).toHaveLength(1);
		expect(h.identity.driver.starts()).toBe(0);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.counts()).toEqual({
			setupRequests: 1,
			unexpectedSandboxRuns: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		expect(h.opened.plan.chat.job).toBeUndefined();
		expect(h.opened.plan.chat.turn).toBeUndefined();
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened)).toBe(SOURCE);
			expect(reopened.chat.entries).toEqual([]);
			expect(reopened.chat.waiting).toEqual([]);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		await h.close();
	}
});

test("an inactive scripted write aborts the current stream and prevents a heading mutation", async () => {
	let h = await scriptedHeading([
		{
			tool: "edit_plan",
			args: { revision: "$revision", operations: [{ op: "insert_root", source: "x\n" }] },
		},
		HEADING,
	]);
	try {
		expect(await h.run()).toEqual({
			status: "failed",
			reason: "Planner tool boundary failure: edit_plan",
		});
		expect(h.driver.tools).toEqual([[...HEADING_TOOL_NAMES]]);
		expect(h.driver.calls[0]?.toolName).toBe("edit_plan");
		expect(h.driver.results).toMatchObject([{
			toolName: "edit_plan",
			output: { type: "execution-denied" },
		}]);
		expect(h.driver.results.some(result => result.toolName === "draft_heading")).toBe(false);
		expect(await h.savedSource()).toBe("");
		expect(Plan.source(h.opened.plan)).toBe("");
		expect(h.opened.broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
		expect(h.opened.plan.chat.entries).toEqual([]);
		expect(h.opened.plan.chat.job).toBeUndefined();
		expect(h.opened.plan.chat.turn).toBeUndefined();
		expect(h.identity.driver.starts()).toBe(0);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.counts()).toEqual({
			setupRequests: 1,
			unexpectedSandboxRuns: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
	} finally {
		await h.close();
	}
});

test("aborting a held current Harness script drains its session without a document write", async () => {
	let h = await scriptedHeading([HEADING], true);
	let controller = new AbortController();
	try {
		let running = h.run(controller.signal);
		await h.driver.entered;
		expect(h.opened.plan.chat.job?.id).toBe("heading:document:m0");
		expect(h.opened.plan.chat.turn).toBeDefined();
		expect(h.driver.calls).toEqual([]);
		controller.abort();
		let outcome = await running;
		expect(outcome.status).toBe("failed");
		expect(h.driver.tools).toEqual([[...HEADING_TOOL_NAMES]]);
		expect(h.driver.calls).toEqual([]);
		expect(h.driver.results).toEqual([]);
		expect(await h.savedSource()).toBe("");
		expect(h.opened.plan.chat.job).toBeUndefined();
		expect(h.opened.plan.chat.turn).toBeUndefined();
		expect(h.opened.plan.chat.busy).toBe(false);
		expect(h.identity.driver.starts()).toBe(0);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.counts()).toEqual({
			setupRequests: 1,
			unexpectedSandboxRuns: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
	} finally {
		controller.abort();
		await h.close();
	}
});

test("abort waits for a held result observer before draining the current Harness session", async () => {
	let h = await scriptedHeading([HEADING, HEADING]);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let controller = new AbortController();
	let settled = false;
	let observerFinished = false;
	try {
		h.onResult(async () => {
			expect(await h.savedSource()).toBe(SOURCE);
			entered.resolve();
			await release.promise;
			observerFinished = true;
		});
		let running = h.run(controller.signal);
		void running.then(() => {
			settled = true;
		});
		await entered.promise;
		controller.abort();
		await Bun.sleep(10);
		expect(settled).toBe(false);
		expect(observerFinished).toBe(false);
		expect(h.driver.destroyed()).toBe(0);
		expect(h.counts()).toEqual({
			setupRequests: 1,
			unexpectedSandboxRuns: 0,
			sandboxDestroys: 0,
			credentialReleases: 0,
		});
		expect(h.driver.calls.map(call => call.toolName)).toEqual(["draft_heading"]);
		release.resolve();
		expect((await running).status).toBe("failed");
		expect(settled).toBe(true);
		expect(observerFinished).toBe(true);
		expect(h.driver.calls.map(call => call.toolName)).toEqual(["draft_heading"]);
		expect(h.driver.results).toHaveLength(1);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.counts()).toEqual({
			setupRequests: 1,
			unexpectedSandboxRuns: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		expect(await h.savedSource()).toBe(SOURCE);
		expect(h.opened.plan.chat.job).toBeUndefined();
		expect(h.opened.plan.chat.turn).toBeUndefined();
	} finally {
		controller.abort();
		release.resolve();
		await h.close();
	}
});
