import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import { BACKGROUND_TOOL_NAMES } from "../harness/tool-names";
import { promptScripted } from "./job-prompt-scripted-harness.test-fixtures";

function result(output: unknown): { revision: number; source?: string; ok?: boolean } {
	return JSON.parse(String(output));
}

function cleanup(h: Awaited<ReturnType<typeof promptScripted>>) {
	expect(h.identity.driver.starts()).toBe(0);
	expect(h.driver.starts()).toBe(1);
	expect(h.driver.destroyed()).toBe(1);
	expect(h.counts()).toEqual({
		setups: 1,
		unexpectedCommands: 0,
		sandboxDestroys: 1,
		credentialReleases: 1,
	});
	expect(h.plan.chat.job).toBeUndefined();
	expect(h.plan.chat.turn).toBeUndefined();
	expect(h.plan.chat.entries.some(entry => entry.tools?.length || entry.streaming)).toBe(false);
	expect(
		h.opened.broadcasts.some(frame => ["chat:tool", "chat:delta"].includes(String(frame.kind))),
	).toBe(false);
}

test("a prompt-only heading model reads the real revision before its durable own-tool write", async () => {
	let h = await promptScripted("heading", [{
		tool: "draft_heading",
		args: {
			revision: "$revision",
			title: "Auth Strategy",
			goal: "Goal: choose authentication for the pilot.",
		},
	}]);
	try {
		expect(h.prompt).toStartWith("[Background job: heading]");
		expect(h.prompt).toContain("Choose authentication for a small pilot.");
		expect((await h.run()).status).toBe("done");
		expect(h.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.heading]]);
		expect(h.driver.calls.map(call => call.toolName)).toEqual(["read_plan", "draft_heading"]);
		expect(h.observations.map(item => item.toolName)).toEqual(["read_plan", "draft_heading"]);
		let [read, write] = h.observations;
		expect(h.driver.calls[0]!.input).toEqual({});
		expect(h.driver.calls[1]!.input).toMatchObject({ revision: result(read!.output).revision });
		expect(result(read!.output).revision).toBe(read!.revision);
		expect(result(read!.output).source).toBe(read!.saved.source);
		expect(write!.saved.source).toBe(
			"# Auth Strategy\n\nGoal: choose authentication for the pilot.\n",
		);
		expect(write!.saved.revision).toBe(h.plan.revision);
		expect(write!.revision).toBeGreaterThan(read!.revision);
		cleanup(h);
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(Plan.source(reopened)).toBe(write!.saved.source);
			expect(reopened.chat.entries).toHaveLength(1);
			expect(reopened.chat.waiting).toEqual([]);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		await h.close();
	}
});

test("a prompt-only refine model renews read_plan between two actual card writes", async () => {
	let title = "Which authentication approach fits the pilot?";
	let rationale = "It keeps the pilot small and concrete.";
	let h = await promptScripted("refine", [
		{
			tool: "refine_decision",
			args: { revision: "$revision", id: "$target", title, add_options: [] },
		},
		{
			tool: "refine_decision",
			args: {
				revision: "$revision",
				id: "$target",
				add_options: [{ label: "GitHub Apps", rationale }],
			},
		},
	]);
	try {
		expect(h.prompt).toStartWith("[Background job: refine]");
		expect(h.prompt).toContain(`Decision card ${h.target}:`);
		let initialRevision = h.plan.revision;
		expect((await h.run()).status).toBe("done");
		expect(h.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.refine]]);
		expect(h.driver.calls.map(call => call.toolName)).toEqual([
			"read_plan",
			"refine_decision",
			"read_plan",
			"refine_decision",
		]);
		expect(h.observations.map(item => item.toolName)).toEqual([
			"read_plan",
			"refine_decision",
			"read_plan",
			"refine_decision",
		]);
		let [firstRead, firstWrite, secondRead, secondWrite] = h.observations;
		let firstRevision = result(firstRead!.output).revision;
		let secondRevision = result(secondRead!.output).revision;
		expect(firstRevision).toBe(initialRevision);
		expect(firstRevision).toBe(firstRead!.revision);
		expect(secondRevision).toBe(firstWrite!.revision);
		expect(secondRevision).toBe(secondRead!.revision);
		expect(secondRevision).toBeGreaterThan(firstRevision);
		expect(h.driver.calls[1]!.input).toEqual({
			revision: firstRevision,
			id: h.target,
			title,
			add_options: [],
		});
		expect(h.driver.calls[3]!.input).toEqual({
			revision: secondRevision,
			id: h.target,
			add_options: [{ label: "GitHub Apps", rationale }],
		});
		expect(firstWrite!.saved.record!.definition.questions[0]!.question).toBe(title);
		expect(firstWrite!.saved.record!.definition.questions[0]!.options).toEqual([]);
		expect(result(secondRead!.output).source).toBe(firstWrite!.saved.source);
		let record = structuredClone(h.plan.records.get(h.target)!);
		let option = record.definition.questions[0]!.options[0]!;
		expect(record.definition.questions[0]!.options).toHaveLength(1);
		expect(option.label).toBe("GitHub Apps");
		expect(option.id).toBeTruthy();
		expect(record.optionOrigins[option.id]).toEqual({ origin: "planner", rationale });
		expect(secondWrite!.saved.record).toEqual(record);
		expect(secondWrite!.saved.source).toBe(Plan.source(h.plan));
		expect(secondWrite!.saved.revision).toBe(secondWrite!.revision);
		expect(secondWrite!.revision).toBeGreaterThan(secondRevision);
		cleanup(h);
		await h.close();
		let reopened = await Plan.open(h.opened.channel.id, h.opened.backend, h.opened.server);
		try {
			expect(reopened.records.get(h.target)).toEqual(record);
			expect(Plan.source(reopened)).toBe(secondWrite!.saved.source);
			expect(reopened.chat.waiting).toEqual([]);
			expect(h.driver.starts()).toBe(1);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		await h.close();
	}
});
