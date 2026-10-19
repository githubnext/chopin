import { expect, test } from "bun:test";
import { projectRequestView, researchFailureMessage } from "./request-view";

test.each([
	["attempts-exhausted:attempt-timeout", "Research timed out before it returned a result."],
	["attempts-exhausted:web-search-timeout", "A public web-search request timed out."],
	[
		"attempts-exhausted:web-search-authorization-timeout",
		"Authorization for public web search timed out.",
	],
	["web-search-unavailable", "The public web-search service was unavailable."],
])("maps the research failure %s to a safe explanation", (reason, expected) => {
	expect(researchFailureMessage(reason)).toBe(expected);
});

test("unknown provider failure text is never included in a research response", () => {
	expect(researchFailureMessage("constructor")).toBe("Research could not be completed.");
	expect(researchFailureMessage("private provider payload https://example.invalid/secret")).toBe(
		"Research could not be completed.",
	);
});

test("running evidence retains searching and exposes its current bounded activity", () => {
	let value = projectRequestView({
		workspace: {
			id: "request",
			channelId: "channel",
			createdAt: new Date(0),
			updatedAt: new Date(0),
		} as never,
		turn: { question: "Compare public providers", evidenceJobId: "evidence" } as never,
		evidence: {
			job: {
				state: "running",
				attempts: 1,
				progress: [{
					attempt: 1,
					stage: "web-search",
					state: "started",
					label: "Waiting for a web-search response",
				}],
			},
		} as never,
		answer: undefined,
		sources: [],
		child: undefined,
	});
	expect(value).toMatchObject({
		stage: "searching",
		activity: "Waiting for a web-search response",
	});
});

test("an evidence job awaiting its retry still reads as searching, not failed", () => {
	let value = projectRequestView({
		workspace: {
			id: "request",
			channelId: "channel",
			createdAt: new Date(0),
			updatedAt: new Date(0),
		} as never,
		turn: { question: "Compare public providers", evidenceJobId: "evidence" } as never,
		evidence: {
			job: {
				state: "pending",
				attempts: 1,
				failures: 1,
				reason: "attempt-timeout",
				progress: [{
					attempt: 1,
					stage: "public-web",
					state: "interrupted",
					label: "Public web research",
				}],
			},
		} as never,
		answer: undefined,
		sources: [],
		child: undefined,
	});
	expect(value).toMatchObject({
		state: "pending",
		stage: "searching",
		activity: "Retrying the web search",
	});
	expect(value).not.toHaveProperty("error");
});
