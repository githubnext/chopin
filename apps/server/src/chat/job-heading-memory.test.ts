import { installJobCleanup } from "./job.test-fixtures";
import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import { HEADING_TOOL_NAMES } from "../harness/tool-names";
import { headingMemory } from "./job-heading-memory.test-fixtures";
import { socket, until } from "./job.test-fixtures";

installJobCleanup();

test("saved room message runs processor through current Harness and the actual durable heading tool", async () => {
	let h = await headingMemory();
	let toolFinished = false;
	let observedJobPending = false;
	try {
		h.onStart(async () => {
			let stored = await h.saved();
			expect(stored.sidecar.conversationPlanEffects).toEqual(["job:heading:document"]);
			expect(stored.sidecar.conversationPlanPendingEffects).toBeUndefined();
			expect(stored.sidecar.conversationPlanJobs).toMatchObject([{ status: "running" }]);
			expect(stored.sidecar.transcript.map(entry => entry.text)).toEqual([
				"Choose our authentication approach.",
			]);
		});
		h.onResult(async output => {
			expect(String(output)).toContain('"ok": true');
			expect((await h.saved()).source).toContain("# Authentication");
			expect(h.plan.conversationPlanJobs[0]?.status).toBe("running");
			observedJobPending = true;
			toolFinished = true;
		});
		let id = crypto.randomUUID();
		await Chat.send(h.context, socket(), {
			kind: "chat:send",
			rid: "send",
			requestId: id,
			to: "room",
			text: "Choose our authentication approach.",
			ts: 0,
		});
		await until(() => toolFinished);
		expect(observedJobPending).toBe(true);
		expect(h.plan.chat.entries).toHaveLength(1);
		expect(h.plan.chat.jobOutput).toBe(
			JSON.stringify({ title: "Authentication", goal: "Choose our authentication approach." }),
		);
		expect(h.driver.tools).toEqual([[...HEADING_TOOL_NAMES]]);
		expect(h.driver.tools[0]).not.toContain("edit_plan");
		h.driver.finish();
		await until(() => h.plan.conversationPlanJobs[0]?.status === "done");
		await h.jobs.idle();
		let saved = await h.saved();
		expect(saved.sidecar.conversationPlanJobs).toMatchObject([{ status: "done", attempts: 1 }]);
		expect(saved.sidecar.transcript.map(entry => entry.text)).toEqual([
			"Choose our authentication approach.",
			"Chopin drafted the title and goal",
		]);
		expect(h.plan.chat.job).toBeUndefined();
		expect(h.driver.destroyed()).toBe(1);
		expect(h.sandboxDestroys()).toBe(1);
		expect(h.errors).toEqual([]);
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened)).toContain("# Authentication");
			expect(reopened.conversationPlanJobs).toMatchObject([{ status: "done" }]);
			expect(reopened.chat.waiting).toEqual([]);
			expect(h.driver.starts()).toBe(1);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		await h.close();
	}
});
