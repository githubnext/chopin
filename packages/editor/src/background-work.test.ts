import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	backgroundJobLabel,
	backgroundJobResult,
	BackgroundWork,
	safeInterruptionReason,
	visibleProgress,
} from "./background-work";
import { JobStore } from "./jobs";

import type { Job } from "@chopin/protocol";
import type { Transport } from "./transport";

function job(overrides: Partial<Job.View> = {}): Job.View {
	return {
		id: "job",
		type: "research-answer",
		version: 1,
		origin: "user",
		targetKey: "research-answer:workspace:one:turn:one:answer",
		targetGeneration: 1,
		state: "running",
		revision: 6,
		attempts: 2,
		failures: 1,
		availableAt: "2026-08-22T12:00:00.000Z",
		progress: [],
		createdAt: "2026-08-22T12:00:00.000Z",
		updatedAt: "2026-08-22T12:00:06.000Z",
		...overrides,
	};
}

function completedResult(): Job.Detail {
	return {
		revision: 1,
		currentTargetGeneration: 1,
		job: job({ state: "completed" }),
		artifact: {
			revision: 1,
			value: {
				kind: "initial",
				report: { title: "Compatibility report", summary: "Compatibility was retained." },
			},
			createdAt: "2026-08-22T12:00:06.000Z",
		},
	};
}

class FixtureWire implements Transport {
	connected = true;

	constructor(private detail: Job.Detail) {}

	on() {
		return () => {};
	}

	send(): void {}

	ask<T>(kind: string): Promise<T> {
		if (kind === "job:list") {
			return Promise.resolve({
				kind: "job:list",
				revision: 1,
				jobs: [this.detail.job],
				truncated: false,
			} as T);
		}
		if (kind === "job:get") {
			return Promise.resolve({ kind: "job:get", detail: this.detail } as T);
		}
		throw new Error(`unexpected request: ${kind}`);
	}
}

async function completedResultStore(): Promise<JobStore> {
	let detail = completedResult();
	let store = new JobStore();
	store.listen(new FixtureWire(detail));
	await store.refresh();
	await store.detail(detail.job.id);
	return store;
}

test("closed result trigger does not reference its unmounted result region", async () => {
	let markup = renderToStaticMarkup(createElement(BackgroundWork, {
		canEdit: false,
		connected: true,
		motion: {
			className: "motion-collapse",
			closeDuration: 250,
			contentClassName: "motion-collapse-content",
			iconClassName: "motion-disclosure-icon",
		},
		store: await completedResultStore(),
	}));

	expect(markup).toMatch(/<button[^>]*aria-expanded="false"/);
	expect(markup).not.toContain("aria-controls");
	expect(markup).not.toContain("Compatibility report");
});

test("progress keeps each attempt and identifies the current stage", () => {
	let progress = visibleProgress(job({
		progress: [{
			revision: 2,
			attempt: 1,
			stage: "public-web",
			label: "Public web research",
			state: "started",
			createdAt: "2026-08-22T12:00:01.000Z",
		}, {
			revision: 3,
			attempt: 1,
			stage: "public-web",
			label: "Public web research",
			state: "completed",
			createdAt: "2026-08-22T12:00:02.000Z",
		}, {
			revision: 5,
			attempt: 2,
			stage: "public-web",
			label: "Public web research",
			state: "started",
			createdAt: "2026-08-22T12:00:05.000Z",
		}],
	}));
	expect(progress.map(entry => ({ attempt: entry.attempt, status: entry.status }))).toEqual([
		{ attempt: 1, status: "Completed" },
		{ attempt: 2, status: "In progress" },
	]);
});

test("an unfinished terminal stage is interrupted", () => {
	let progress = visibleProgress(job({
		state: "failed",
		progress: [{
			revision: 2,
			attempt: 1,
			stage: "public-web",
			label: "Public web research",
			state: "started",
			createdAt: "2026-08-22T12:00:01.000Z",
		}],
	}));
	expect(progress[0]?.status).toBe("Interrupted");
});

test("an interruption explains its safe failure reason", () => {
	let progress = visibleProgress(job({
		state: "failed",
		progress: [{
			revision: 2,
			attempt: 2,
			stage: "public-web",
			label: "Public web research",
			state: "started",
			createdAt: "2026-08-22T12:00:01.000Z",
		}, {
			revision: 3,
			attempt: 2,
			stage: "public-web",
			label: "Public web research",
			state: "interrupted",
			reason: "web-search-unavailable",
			createdAt: "2026-08-22T12:00:02.000Z",
		}],
	}));
	expect(progress[0]).toMatchObject({
		status: "Interrupted",
		detail: "Copilot web search is unavailable",
	});
});

test("terminal reasons are mapped without exposing raw values", () => {
	expect(safeInterruptionReason("attempt-error")).toBe("Worker failed unexpectedly");
	expect(safeInterruptionReason("attempts-exhausted:private-answer-failed"))
		.toBe("Private research answer failed");
	expect(safeInterruptionReason("provider-secret:https://private.example"))
		.toBe("Worker stopped unexpectedly");
});

test("research labels use bounded subjects and never target keys", () => {
	expect(backgroundJobLabel(job({ type: "research-evidence", subject: "  What   changed?  " })))
		.toBe("Research evidence: What changed?");
	expect(backgroundJobLabel(job({ subject: undefined }))).toBe("Research answer");
	expect(backgroundJobLabel(job({ type: "other", subject: "private" }))).toBe("Background work");
});

test("decodes initial reports and continuation answers only for answer jobs", () => {
	let initial = {
		revision: 1,
		currentTargetGeneration: 1,
		job: job({ state: "completed" }),
		artifact: {
			revision: 1,
			value: {
				kind: "initial",
				report: { title: "Compatibility report", summary: "Compatibility was retained." },
			},
			createdAt: "2026-08-22T12:00:06.000Z",
		},
	} satisfies Job.Detail;
	let continuation = {
		...initial,
		artifact: {
			...initial.artifact,
			value: { kind: "follow-up", answer: { text: "The old client was tested." } },
		},
	} satisfies Job.Detail;
	expect(backgroundJobResult(initial)).toEqual({
		title: "Compatibility report",
		summary: "Compatibility was retained.",
	});
	expect(backgroundJobResult(continuation)).toEqual({
		title: "Research answer",
		summary: "The old client was tested.",
	});
	expect(backgroundJobResult({
		...initial,
		job: job({ type: "research-evidence", state: "completed" }),
	})).toBeUndefined();
	expect(backgroundJobResult({ ...initial, currentTargetGeneration: 2 })).toBeUndefined();
	expect(backgroundJobResult({
		...initial,
		job: job({ state: "superseded" }),
	})).toBeUndefined();
});

test("distinguishes marked descriptions from markerless legacy summaries", () => {
	let descriptionJob = job({ type: "document-summary", state: "completed" });
	let marked = {
		revision: 1,
		currentTargetGeneration: 1,
		job: descriptionJob,
		artifact: {
			revision: 1,
			value: { output: "description", description: "Coordinates release readiness." },
			createdAt: "2026-08-22T12:00:06.000Z",
		},
	} satisfies Job.Detail;
	let legacy = {
		...marked,
		artifact: {
			...marked.artifact,
			value: { summary: "A longer legacy document summary." },
		},
	} satisfies Job.Detail;

	expect(backgroundJobResult(marked)).toEqual({
		title: "Document description",
		summary: "Coordinates release readiness.",
	});
	expect(backgroundJobLabel(descriptionJob)).toBe("Document description");
	expect(backgroundJobLabel(descriptionJob, marked)).toBe("Document description");
	expect(backgroundJobResult(legacy)).toEqual({
		title: "Document summary",
		summary: "A longer legacy document summary.",
	});
	expect(backgroundJobLabel(descriptionJob, legacy)).toBe("Document summary");
	expect(backgroundJobResult({
		...marked,
		artifact: { ...marked.artifact, value: { description: "Missing marker" } },
	})).toBeUndefined();
});
