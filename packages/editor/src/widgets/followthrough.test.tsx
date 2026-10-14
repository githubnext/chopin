import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { followthroughLabel, FollowthroughStatus } from "./followthrough";
import { ResearchCard, ResearchReference } from "./research";
import type { Followthrough, Research } from "@chopin/protocol";
import type { ResearchStore } from "../widget-options";

let base: Followthrough.View = { id: "review-1", revision: 1, status: "pending" };

test("review status describes durable progress without claiming document changes", () => {
	let cases: Array<[Followthrough.Status, string | undefined, string]> = [
		["pending", undefined, "Waiting to review findings"],
		["pending", "owner-unavailable", "Waiting for the Planner"],
		["pending", "remote-unavailable", "Waiting for a connected Planner"],
		["pending", "document-locked", "Waiting for the build to finish"],
		["pending", "planner-busy", "Waiting for the current turn"],
		["running", undefined, "Reviewing findings"],
		["done", undefined, "Findings reviewed"],
		["failed", "interrupted", "Review interrupted"],
		["failed", "private worker failure", "Review failed"],
		["skipped", "dismissed", "Review dismissed"],
		["skipped", "source-stale", "No longer relevant"],
	];
	for (let [status, reason, expected] of cases) {
		expect(followthroughLabel({ ...base, status, reason })).toBe(expected);
	}
	expect(followthroughLabel({ ...base, reason: "private worker failure" })).toBe(
		"Waiting to review findings",
	);
	expect(followthroughLabel({ ...base, reason: "constructor" })).toBe("Waiting to review findings");
});

test("review actions appear only for writers at actionable states", () => {
	let render = (status: Followthrough.Status, canEdit = true, busy = false) =>
		renderToStaticMarkup(createElement(FollowthroughStatus, {
			view: { ...base, status },
			canEdit,
			busy,
			onRetry() {},
			onDismiss() {},
		}));
	expect(render("pending")).toContain(">Dismiss review</button>");
	expect(render("pending")).not.toContain("Retry review");
	expect(render("failed")).toContain(">Retry review</button>");
	expect(render("failed")).toContain(">Dismiss review</button>");
	for (let status of ["running", "done", "skipped"] as const) {
		expect(render(status)).not.toContain("<button");
	}
	expect(render("failed", false)).toContain("Review failed");
	expect(render("failed", false)).not.toContain("<button");
	expect(render("failed", true, true).match(/disabled=""/g)).toHaveLength(2);
});

test("a ready research card keeps its report open action beside independent review controls", () => {
	let request: Research.RequestView = {
		id: "research",
		channelId: "document",
		question: "Measure startup costs",
		createdAt: "",
		updatedAt: "",
		sources: [],
		state: "completed",
		stage: "ready",
		child: {
			id: "child",
			slug: "startup-report",
			title: "Startup report",
			summary: "Measured costs.",
			sourceCount: 0,
		},
		followthrough: { ...base, status: "failed", reason: "interrupted" },
	};
	let render = (canEdit: boolean) =>
		renderToStaticMarkup(createElement(ResearchCard, {
			request,
			canEdit,
			onOpen() {},
			onRetryReview() {},
			onDismissReview() {},
		}));
	let markup = render(true);
	expect(markup).toContain('aria-label="Open Startup report"');
	expect(markup).toContain("Measured costs.");
	expect(markup).toContain("Review interrupted");
	expect(markup).toContain(">Retry review</button>");
	expect(markup).toContain(">Dismiss review</button>");
	expect(markup).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
	expect(render(false)).toContain('aria-label="Open Startup report"');
	expect(render(false)).not.toContain("Retry review");
});

test("inline review scheduling uses writer capability even when document editing is locked", () => {
	let request: Research.RequestView = {
		id: "research",
		channelId: "document",
		question: "Measure startup costs",
		sources: [],
		createdAt: "",
		updatedAt: "",
		state: "completed",
		stage: "ready",
		child: { id: "child", slug: "report", title: "Report", summary: "Costs.", sourceCount: 0 },
		followthrough: { ...base, status: "failed" },
	};
	let store: ResearchStore = {
		subscribe: () => () => {},
		retain: () => () => {},
		get: () => request,
		mutating: () => false,
		refresh() {},
		create: async () => request,
		cancel: async () => request,
		retry: async () => request,
		review: async () => request,
		opener: () => ({ current: null }),
		open() {},
	};
	let render = (canReviewResults: boolean) =>
		renderToStaticMarkup(createElement(ResearchReference, {
			id: request.id,
			store,
			canEdit: false,
			canReviewResults,
			onRemove() {},
		}));
	expect(render(true)).toMatch(/<button(?![^>]*disabled)[^>]*>Retry review<\/button>/);
	expect(render(true)).toMatch(/<button(?![^>]*disabled)[^>]*>Dismiss review<\/button>/);
	expect(render(true)).not.toContain("Remove research reference");
	expect(render(false)).not.toContain("Retry review");
	expect(render(false)).toContain("Review failed");
});
