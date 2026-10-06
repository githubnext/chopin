import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationPlan } from "@chopin/protocol";
import { ResearchDiagnostics } from "./research-diagnostics";

function analysis(): ConversationPlan.ResearchAnalysis {
	return {
		messageId: "message",
		questionSetVersion: "conversation-research-1",
		policyVersion: "research-admission-2",
		modelVersion: "jev-1.13.0",
		status: "unlinked",
		latencyMs: 358,
		policyGate: "External suitability below threshold: 79%; required 80%.",
		answers: {
			research_subject: {
				type: "choice",
				choice: "contextual",
				confidence: 0.27,
				probabilities: { explicit: 0.4, contextual: 0.47, unclear: 0.13 },
			},
		},
		admission: {
			path: "inferred-opportunity",
			checks: [
				{ signal: "research_warranted", score: 0.89, threshold: 0.8, comparison: "minimum" },
				{ signal: "external", score: 0.79, threshold: 0.8, comparison: "minimum" },
				{ signal: "owned", score: 0.88, threshold: 0.8, comparison: "minimum" },
				{ signal: "subject_clarity", score: 0.87, threshold: 0.8, comparison: "minimum" },
				{ signal: "already_answered", score: 0.18, threshold: 0.2, comparison: "maximum" },
			],
		},
	};
}

test("research diagnostics distinguish policy thresholds and combined clarity from model confidence", () => {
	let html = renderToStaticMarkup(
		<ResearchDiagnostics
			analysis={analysis()}
			pending={false}
			canEdit={false}
			onRetry={async () => {}}
		/>,
	);
	expect(html).toContain("Policy research-admission-2");
	expect(html).toContain("Admission path: Inferred opportunity");
	expect(html).toContain("External suitability below threshold: 79%; required 80%.");
	expect(html).toContain("79% (minimum 80%; not met)");
	expect(html).toContain("Subject clarity (explicit + contextual)");
	expect(html).toContain("87% (minimum 80%; met)");
	expect(html).toContain("contextual · 27% confidence");
});

test("historical research analyses display their original outcome without inventing a policy", () => {
	let historical = analysis();
	delete historical.admission;
	delete historical.policyVersion;
	historical.policyGate = "not external research";
	let html = renderToStaticMarkup(
		<ResearchDiagnostics
			analysis={historical}
			pending={false}
			canEdit={false}
			onRetry={async () => {}}
		/>,
	);
	expect(html).toContain("not external research");
	expect(html).not.toContain("Admission path");
	expect(html).not.toContain("Policy research-admission-2");
});
