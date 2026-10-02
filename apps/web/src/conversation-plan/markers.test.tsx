import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobsOnlyDiagnostics, MessageMarkers, PlannerJobDiagnostics } from "./markers";
import { jobsForMessage } from "./links";

import type { ConversationPlan } from "@chopin/protocol";

function source(start: number): ConversationPlan.SourceRef {
	return {
		messageId: "message-1",
		author: { kind: "member", handle: "ana" },
		quote: `quote ${start}`,
		start,
		end: start + 1,
		role: "option",
	};
}

function state(
	linkCount = 0,
	analysisStatus?: ConversationPlan.AnalysisRecord["status"],
): ConversationPlan.State {
	let sources = Array.from({ length: linkCount }, (_, index) => source(index * 2));
	return {
		schemaVersion: 1,
		revision: 1,
		events: [],
		threads: linkCount
			? [{
				id: "thread-1",
				question: "Which option?",
				questionSources: [],
				questionAuthoring: "quoted",
				status: "exploring",
				contributions: sources.map((item, index) => ({
					id: `link-${index + 1}`,
					kind: "option",
					text: `Option ${index + 1}`,
					authoring: "quoted",
					sources: [item],
					actor: { kind: "member", handle: "ana" },
				})),
				stances: [],
				stanceHistory: [],
				decisionHistory: [],
				candidates: [],
				version: 1,
			}]
			: [],
		queue: [],
		analysis: analysisStatus
			? [{
				messageId: "message-1",
				questionSetVersion: "v1",
				modelVersion: "m1",
				status: analysisStatus,
				passes: [],
				eventIds: [],
			}]
			: [],
	};
}

function job(
	status: ConversationPlan.Job["status"] = "failed",
	trigger = "message-1",
): ConversationPlan.Job {
	return {
		id: "refine:card-1:event-1",
		kind: "refine",
		target: "card-1",
		trigger,
		status,
		attempts: 1,
		reason: "The card could not be refined.",
		output: "Updated title: Auth strategy.",
		at: "2026-09-25T10:00:00.000Z",
	};
}

function markup(current: ConversationPlan.State, jobs: ConversationPlan.Job[] = []) {
	return renderToStaticMarkup(createElement(MessageMarkers, {
		canEdit: true,
		jobs,
		messageId: "message-1",
		onCard() {},
		onRetry: async () => {},
		onRetryJob: async () => {},
		state: current,
	}));
}

test("a job keeps the diagnostics marker visible after analysis is pruned", () => {
	let pruned = state();
	pruned.analysis = Array.from({ length: 64 }, (_, index) => ({
		messageId: `newer-message-${index}`,
		questionSetVersion: "v1",
		modelVersion: "m1",
		status: "applied" as const,
		passes: [],
		eventIds: [],
	}));
	let html = markup(pruned, [job()]);
	let unrelated = markup(pruned, [job("failed", "message-2")]);

	expect(html).toContain('aria-label="Analysis for message: Planner jobs"');
	expect(unrelated).toBe("");
});

test("jobs-only diagnostics do not claim that message analysis was unlinked", () => {
	let html = renderToStaticMarkup(createElement(JobsOnlyDiagnostics, {
		canEdit: true,
		jobs: [job("done")],
		onClose() {},
		onRetryJob: async () => {},
	}));

	expect(html).toContain("Planner jobs");
	expect(html).toContain("refine · done");
	expect(html).toContain('aria-label="Close Planner jobs"');
	expect(html).not.toContain("Unlinked");
	expect(html).not.toContain("not recorded");
	expect(html).not.toContain("No card change was accepted");
});

test("failed Planner jobs show their reason, output and retry control", () => {
	let html = renderToStaticMarkup(createElement(PlannerJobDiagnostics, {
		canEdit: true,
		jobs: [job()],
		onRetryJob: async () => {},
	}));

	expect(html).toContain('aria-label="Planner jobs"');
	expect(html).toContain("refine · failed — The card could not be refined.");
	expect(html).toContain("Updated title: Auth strategy.");
	expect(html).toContain('type="button"');
	expect(html).toContain("Retry refine job");
});

test("a failed generation-keyed prose job remains inspectable from the card's opening message", () => {
	let current = state(1);
	current.threads[0]!.questionSources = [source(0)];
	current.threads[0]!.questionnaireId = "card-1";
	let prose: ConversationPlan.Job = {
		...job(),
		id: "prose:card-1:decided:card-1:2",
		kind: "prose",
		trigger: "decided:card-1:2",
		reason: "The writer failed.",
	};
	let html = markup(current, [prose]);
	expect(html).toContain('aria-label="Analysis for message: applied"');
	expect(html).toContain('data-analysis-trigger="true"');
	expect(html).toContain('class="btn btn-icon btn-ghost absolute right-0 top-0"');
	let diagnostics = renderToStaticMarkup(createElement(PlannerJobDiagnostics, {
		canEdit: true,
		jobs: jobsForMessage(current, [prose], "message-1"),
		onRetryJob: async () => {},
	}));
	expect(diagnostics).toContain("prose · failed — The writer failed.");
	expect(diagnostics).toContain("Retry prose job");
});

test("read-only job diagnostics omit retry controls", () => {
	let html = renderToStaticMarkup(createElement(PlannerJobDiagnostics, {
		canEdit: false,
		jobs: [job()],
		onRetryJob: async () => {},
	}));

	expect(html).toContain("refine · failed");
	expect(html).not.toContain("Retry refine job");
});

test("unlinked analysis gets a visible code button without a status dot", () => {
	let html = markup(state(0, "unlinked"));

	expect(html).toContain('aria-label="Analysis for message: unlinked"');
	expect(html).not.toContain("Unlinked");
	expect(html).toContain('class="btn btn-icon btn-ghost absolute right-0 top-0"');
	expect(html).not.toContain('class="block size-1.5 rounded-full');
});

test("message markers render at most three accepted card links", () => {
	let html = markup(state(4, "applied"));

	expect(html.match(/data-card-link=/g)).toHaveLength(3);
	expect(html).toContain('data-card-link="link-1"');
	expect(html).toContain('data-card-link="link-3"');
	expect(html).not.toContain('data-card-link="link-4"');
	expect(html).toContain('aria-label="Analysis for message: applied"');
});
