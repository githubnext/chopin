import { describe, expect, it } from "bun:test";

import {
	beginResearchSubmission,
	completeResearchSubmission,
	decodeResearchAnswerArtifact,
	editResearchSubmission,
	externalResearchUrl,
	latestResearchJobRevision,
	mergeResearchWorkspaceDetail,
} from "./research-workspace-model";

import type { Job, Research } from "@chopin/protocol";
import type * as Api from "./api";

let source = { title: "Release notes", url: "https://example.com/releases/1" };
let basis = {
	workspaceId: "workspace-one",
	turnId: "turn-one",
	documentRevision: 7,
	documentSourceHash: `sha256:${"a".repeat(64)}`,
	model: "research-model",
	sources: [source],
};

function job(revision: number, state: Job.State): Job.Detail {
	let now = "2026-08-23T12:00:00.000Z";
	return {
		revision,
		currentTargetGeneration: 1,
		job: {
			id: "answer-job",
			type: "research-answer",
			version: 1,
			origin: "user",
			targetKey: "research-answer:workspace:workspace-one:turn:turn-one:answer",
			targetGeneration: 1,
			state,
			revision,
			attempts: 1,
			failures: 0,
			availableAt: now,
			progress: [],
			createdAt: now,
			updatedAt: now,
		},
	};
}

function workspace(revision: number, answer: Job.Detail): Api.ResearchWorkspaceDetail {
	let now = "2026-08-23T12:00:00.000Z";
	let summary: Research.WorkspaceSummary = {
		id: "workspace-one",
		channelId: "channel-one",
		title: "Research",
		proposedQuestion: "What changed?",
		confirmedQuery: "What changed?",
		origin: "sidebar",
		createdBy: "user-one",
		confirmedBy: "user-one",
		revision,
		createdAt: now,
		updatedAt: now,
	};
	return {
		workspace: summary,
		turns: [{
			id: "turn-one",
			workspaceId: summary.id,
			ordinal: 1,
			kind: "initial",
			question: summary.confirmedQuery!,
			requestedBy: "user-one",
			answerJobId: answer.job.id,
			answer,
			createdAt: now,
			updatedAt: now,
		}],
		messages: [],
	};
}

describe("research report decoding", () => {
	it("decodes a cited initial report and continuation answer", () => {
		let initial = decodeResearchAnswerArtifact({
			...basis,
			kind: "initial",
			publicFindings: ["Public"],
			privateFindings: ["Private"],
			report: {
				title: "Compatibility report",
				summary: "Compatibility was retained.",
				findings: [{ text: "The release is compatible.", sourceUrls: [source.url] }],
				caveats: ["Only public releases were checked."],
			},
		});
		let followUp = decodeResearchAnswerArtifact({
			...basis,
			kind: "follow-up",
			answer: { text: "The old client was tested.", sourceUrls: [source.url] },
		});

		expect(initial).toMatchObject({ kind: "initial", report: { title: "Compatibility report" } });
		expect(followUp).toMatchObject({ kind: "follow-up", answer: { sourceUrls: [source.url] } });
	});

	it("rejects malformed reports, uncatalogued citations, and non-HTTPS links", () => {
		expect(decodeResearchAnswerArtifact({
			...basis,
			kind: "initial",
			report: {
				title: "Unsafe",
				summary: "Summary",
				findings: [{ text: "Finding", sourceUrls: ["https://other.example/source"] }],
				caveats: [],
			},
		})).toBeUndefined();
		expect(decodeResearchAnswerArtifact({ ...basis, sources: [], kind: "initial" }))
			.toBeUndefined();
		expect(externalResearchUrl("http://example.com/source")).toBeUndefined();
		expect(externalResearchUrl("https://user:secret@example.com/source")).toBeUndefined();
	});
});

describe("research request id lifecycle", () => {
	it("retains one id for an exact retry and clears it only after success", () => {
		let ids = ["request-one", "request-two"];
		let nextId = () => ids.shift()!;
		let draft = { text: "What changed?" };
		let first = beginResearchSubmission(draft, "search-more", nextId);
		let retry = beginResearchSubmission(first, "search-more", nextId);

		expect(retry.requestId).toBe("request-one");
		expect(completeResearchSubmission()).toEqual({ text: "" });
	});

	it("allocates a new id when text or explicit action changes", () => {
		let counter = 0;
		let nextId = () => `request-${++counter}`;
		let first = beginResearchSubmission({ text: "Question" }, "follow-up", nextId);
		let edited = editResearchSubmission(first, "Question with new evidence");
		let changedText = beginResearchSubmission(edited, "follow-up", nextId);
		let changedAction = beginResearchSubmission(changedText, "search-more", nextId);

		expect([first.requestId, changedText.requestId, changedAction.requestId]).toEqual([
			"request-1",
			"request-2",
			"request-3",
		]);
	});
});

describe("research workspace response ordering", () => {
	it("retains newer job state when a later workspace mutation carries an older job projection", () => {
		let running = workspace(3, job(8, "running"));
		let mutation = workspace(4, job(7, "pending"));
		let merged = mergeResearchWorkspaceDetail(running, mutation);

		expect(merged.workspace.revision).toBe(4);
		expect(merged.turns[0]?.answer?.job.state).toBe("running");
		expect(latestResearchJobRevision(merged)).toBe(8);
	});
});
