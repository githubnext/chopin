import { describe, expect, test } from "bun:test";

import {
	messageSpeaker,
	plannerResearchHandoff,
	researchOfferHandoff,
	researchOfferSubagents,
	researchSpeaker,
	SPEAKER_TAGS,
	toolSpeaker,
	toolState,
} from "./speakers";

describe("messageSpeaker", () => {
	test("a person is an untagged user named by their handle as written, with the time", () => {
		let sent = messageSpeaker({
			author: { kind: "member", handle: "mona_acme" },
			ts: 1_700_000_000,
		});
		expect(sent.kind).toBe("user");
		expect(sent.name).toBe("mona_acme");
		expect(sent.handle).toBe("mona_acme");
		expect(sent.time).toMatch(/\d{2}:\d{2}/);
	});

	test("handles keep their capitals, digits, underscores and hyphens", () => {
		for (let handle of ["Hubot-Bot", "lavaman131", "Octo_Cat-2"]) {
			expect(messageSpeaker({ author: { kind: "member", handle } }).name).toBe(handle);
		}
	});

	test("chopin is the agent, and says when a running turn started", () => {
		let working = messageSpeaker({
			author: { kind: "agent" },
			ts: 1_700_000_000,
			activeTs: 1_700_000_001,
		});
		expect(working.kind).toBe("agent");
		expect(working.name).toBe("chopin");
		expect(working.handle).toBeUndefined();
		expect(working.time).toMatch(/^Started at /);
	});
});

test("each app kind has its tag, as Slack tags an app, and a person has none", () => {
	expect(SPEAKER_TAGS).toEqual({ agent: "Agent", subagent: "Subagent", tool: "Tool" });
	expect(researchSpeaker()).toEqual({ kind: "subagent", name: "Research" });
	expect(researchSpeaker(1_700_000_000).time).toMatch(/\d{2}:\d{2}/);
	expect(toolSpeaker({ id: "c1", name: "read_plan", status: "done" })).toEqual({
		kind: "tool",
		name: "Read plan",
	});
});

describe("toolState", () => {
	test("a tool call says how long it took when done, and why when it did not finish", () => {
		let idle = { active: false, disconnected: false };
		expect(toolState({ id: "c1", name: "read_plan", status: "done", took: 42 }, idle)).toEqual({
			status: "Done",
			toolStatus: "done",
			detail: "42ms",
		});
		expect(toolState({ id: "c1", name: "read_plan", status: "done" }, idle)).toEqual({
			status: "Done",
			toolStatus: "done",
		});
		expect(toolState({ id: "c2", name: "fetch", status: "failed", took: 38 }, idle)).toEqual({
			status: "Failed",
			toolStatus: "failed",
			detail: "Failed",
		});
		expect(toolState({ id: "c3", name: "edit_plan", status: "running" }, idle)).toEqual({
			status: "Interrupted",
			toolStatus: "interrupted",
			detail: "Interrupted",
		});
		expect(
			toolState({ id: "c4", name: "edit_plan", status: "running" }, {
				active: false,
				disconnected: true,
			}),
		).toEqual({ status: "Last seen running", toolStatus: "running", detail: "Last seen running" });
		expect(
			toolState({ id: "c5", name: "edit_plan", status: "running" }, {
				active: true,
				disconnected: false,
			}),
		).toEqual({ status: "Running", toolStatus: "running" });
	});
});

describe("research delegation views", () => {
	test("maps an accepted offer across handoff and subagent worker stages", () => {
		let offer = {
			id: "offer-1",
			needId: "need-1",
			contextId: "ctx-1",
			brief: "Compare self-hosted search engines",
			status: "accepted" as const,
			source: {
				messageId: "m1",
				author: { kind: "member" as const, handle: "ana" },
				quote: "Compare self-hosted search",
				start: 0,
				end: 26,
			},
			workflow: {
				published: true,
				preparation: "ready" as const,
				sources: [
					{
						messageId: "m1",
						author: { kind: "member" as const, handle: "ana" },
						quote: "Compare self-hosted search",
						start: 0,
						end: 26,
					},
					{
						messageId: "m2",
						author: { kind: "member" as const, handle: "bo" },
						quote: "Needs SSO support",
						start: 0,
						end: 17,
					},
				],
				additions: [],
			},
		};

		let queued = researchOfferHandoff(offer, "queued");
		expect(queued).toEqual({
			from: "chopin",
			to: "Research",
			reason: "Handing off the research brief to a child document.",
			carried: ["Compare self-hosted search", "Needs SSO support"],
			settled: false,
		});
		expect(researchOfferHandoff(offer, "searching").settled).toBe(true);
		expect(researchOfferHandoff(offer, "ready").reason).toBe(
			"Published findings in a child document.",
		);

		expect(researchOfferSubagents("queued")?.completedCount).toBe(0);
		expect(researchOfferSubagents("searching")?.progress).toEqual([55, 15]);
		expect(researchOfferSubagents("analyzing")?.completedCount).toBe(1);
		expect(researchOfferSubagents("writing")).toMatchObject({
			completedCount: 2,
			showSummary: true,
			summaryAgent: { name: "Write research report", model: "report" },
		});
		expect(researchOfferSubagents("ready")).toBeUndefined();
		expect(researchOfferSubagents("failed")).toBeUndefined();
	});

	test("maps a create_research_workspace tool call to an agent handoff", () => {
		expect(
			plannerResearchHandoff([
				{
					id: "call-1",
					name: "create_research_workspace",
					status: "running",
					args: JSON.stringify({ question: "Check OAuth device flow limits" }),
				},
			]),
		).toEqual({
			from: "chopin",
			to: "Research",
			reason: "Check OAuth device flow limits",
			carried: [],
			settled: false,
		});
		expect(
			plannerResearchHandoff([
				{ id: "call-2", name: "create_research_workspace", status: "failed" },
			]),
		).toBeUndefined();
	});
});
