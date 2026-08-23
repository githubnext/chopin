import { expect, test } from "bun:test";

import { visibleProgress } from "./background-work";

import type { Job } from "@chopin/protocol";

function job(overrides: Partial<Job.View> = {}): Job.View {
	return {
		id: "job",
		type: "research-question",
		version: 1,
		origin: "user",
		targetKey: "research-question:question",
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
