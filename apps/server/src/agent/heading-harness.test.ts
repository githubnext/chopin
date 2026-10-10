import { expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import * as Room from "../plan/room";
import { openPlannerSession } from "../harness/session";
import { scopedJobTools } from "./job-tools";
import { documentRoom, headingSession, INPUT } from "./heading-harness.test-fixtures";

function running(plan: Service.Plan) {
	plan.chat.job = {
		id: "heading:document:m0",
		kind: "heading",
		target: "document",
		trigger: "m0",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

test("current Harness executes heading against durable memory before returning its result", async () => {
	let context = await openPlan();
	running(context.plan);
	let observed = false;
	let hosted = await headingSession(documentRoom(context), async result => {
		expect(result).toMatchObject({ output: expect.stringContaining('"ok": true') });
		let source = `# ${INPUT.title}\n\n${INPUT.goal}\n`;
		let loaded = await context.storage.collaboration.load(context.channel.id, context.now);
		expect((await Service.readStored(loaded!)).source).toBe(source);
		expect(Room.project(context.plan.document)).toBe(source);
		expect(result).toMatchObject({
			output: JSON.stringify(
				{ ok: true, title: INPUT.title, goal: INPUT.goal, revision: 1 },
				null,
				2,
			),
		});
		observed = true;
	});
	try {
		let stream = await hosted.session.stream(
			"Give the empty document a heading",
			hosted.owner.signal,
		);
		for await (let _part of stream.fullStream) {}
		expect(observed).toBe(true);
		expect(context.plan.chat.jobOutput).toBe(
			JSON.stringify({ title: INPUT.title, goal: INPUT.goal }),
		);
		expect(hosted.names()).toContain("draft_heading");
		expect(hosted.names()).toContain("read_plan");
		for (
			let name of [
				"edit_plan",
				"ask",
				"anchor_plan",
				"reply_comment",
				"edit_implementation_graph",
				"create_research_workspace",
				"bash",
				"read_file",
				"web_search",
				"refine_decision",
				"write_decision_prose",
			]
		) expect(hosted.names()).not.toContain(name);
	} finally {
		await hosted.session.destroy();
		await Service.close(context.plan);
	}
	expect(hosted.destroyed).toEqual({ session: 1, sandbox: 1 });
});

test("actual execution boundary refuses foreign writes even when a harness keeps old tools", async () => {
	let context = await openPlan();
	let writes = 0;
	let scoped = scopedJobTools({
		edit_plan: tool({
			inputSchema: z.object({}),
			execute: async () => {
				writes++;
				return "written";
			},
		}),
	}, documentRoom(context));
	try {
		let options = { toolCallId: "old-tool", messages: [], context: undefined };
		expect(await scoped.edit_plan!.execute!({} as never, options)).toBe("written");
		running(context.plan);
		expect(await scoped.edit_plan!.execute!({} as never, options)).toBe(
			"Error: This is a background heading job; use only draft_heading. edit_plan is not available.",
		);
		expect(writes).toBe(1);
		expect(Room.project(context.plan.document)).toBe("");
	} finally {
		await Service.close(context.plan);
	}
});

test("unsupported background jobs cannot open an ordinary writable Planner session", async () => {
	let context = await openPlan();
	running(context.plan);
	context.plan.chat.job = { ...context.plan.chat.job!, kind: "unknown" as never, target: "thread" };
	let called = false;
	try {
		let opened = await openPlannerSession({} as never, {
			room: documentRoom(context),
			repository: {} as never,
			instructions: "Unsupported background kind",
		}, {
			githubTools: async () => {
				called = true;
				throw new Error("must not fetch tools");
			},
		});
		expect(opened.ok).toBe(false);
		if (opened.ok) throw new Error("unsupported job opened a session");
		expect(opened.error).toMatchObject({ kind: "Unavailable" });
		if (!("cause" in opened.error)) throw new Error("missing failure cause");
		expect((opened.error.cause as Error).message).toBe(
			"Background unknown tools are not available",
		);
		expect(called).toBe(false);
		expect(Room.project(context.plan.document)).toBe("");
	} finally {
		await Service.close(context.plan);
	}
});
