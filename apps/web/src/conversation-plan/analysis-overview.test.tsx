import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AnalysisOverview } from "./analysis-overview";

import type { ConversationPlan } from "@chopin/protocol";

test("analysis leads with applied and held excerpts, then explains Jev and policy", () => {
	let messageText = "We should use S3, but it must be encrypted.";
	let first = "We should use S3";
	let second = "it must be encrypted";
	let analysis: ConversationPlan.AnalysisRecord = {
		messageId: "message-1",
		questionSetVersion: "conversation-plan-5",
		modelVersion: "jev-1",
		status: "applied",
		passes: [{
			stage: "triage",
			answers: {
				new_option: { type: "noul", noul: 0.94 },
				constraint: { type: "noul", noul: 0.86 },
			},
		}],
		outcomes: [{
			start: messageText.indexOf(first),
			end: messageText.indexOf(first) + first.length,
			status: "accepted",
			gate: "accepted",
			eventIds: ["event-1"],
		}, {
			start: messageText.indexOf(second),
			end: messageText.indexOf(second) + second.length,
			status: "review",
			gate: "contribution target needs review",
			eventIds: [],
		}],
		eventIds: ["event-1"],
		policyGate: "0:accepted; 1:contribution target needs review",
	};
	let html = renderToStaticMarkup(createElement(AnalysisOverview, {
		analysis,
		links: [],
		messageText,
		status: "applied",
	}));

	expect(html).toContain("1 finding applied");
	expect(html).toContain("Jev detected");
	expect(html).toContain("Proposal");
	expect(html).toContain("Constraint");
	expect(html).toContain(`“${first}”`);
	expect(html).toContain(`“${second}”`);
	expect(html).toContain("contribution target needs review");
	expect(html).toContain("Model answers and run details");
	expect(html).toContain("94% signal");
	expect(html).not.toContain("{&quot;type&quot;");
});
