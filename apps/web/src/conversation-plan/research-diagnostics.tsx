import type { ConversationPlan } from "@chopin/protocol";
import { answerText, questionName } from "./analysis-labels";

const PATHS: Record<ConversationPlan.ResearchAdmission["path"], string> = {
	"explicit-proposal": "Explicit proposal",
	"inferred-opportunity": "Inferred opportunity",
	"existing-offer-update": "Existing-offer update",
};
const CHECKS: Record<ConversationPlan.ResearchAdmission["checks"][number]["signal"], string> = {
	research_warranted: "Research need",
	external: "External suitability",
	owned: "Source ownership",
	subject_clarity: "Subject clarity (explicit + contextual)",
	already_answered: "Already-answered evidence",
};

function percent(value: number): string {
	return `${Number((value * 100).toFixed(2))}%`;
}

export function ResearchDiagnostics({ analysis, pending }: {
	analysis?: ConversationPlan.ResearchAnalysis;
	pending: boolean;
}) {
	if (!analysis && !pending) return null;
	return (
		<section
			aria-label="Research analysis"
			className="mt-2 hairline-t pt-2 text-sm leading-4 text-text-tertiary"
		>
			<h4 className="m-0 text-sm text-text-primary">Research</h4>
			{pending ? <p className="m-0 mt-1">Waiting for research analysis</p> : (
				<>
					<p className="m-0 mt-1">{analysis!.policyGate}</p>
					<p className="m-0 mt-1">
						Model {analysis!.modelVersion} · Questions {analysis!.questionSetVersion} ·{" "}
						{analysis!.policyVersion && <>Policy {analysis!.policyVersion} ·{" "}</>}
						{analysis!.latencyMs} ms
					</p>
					{analysis!.admission && (
						<section className="mt-2" aria-label="Research admission policy">
							<p className="m-0">Admission path: {PATHS[analysis!.admission.path]}</p>
							<dl className="m-0 mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
								{analysis!.admission.checks.map(check => {
									let passed = check.comparison === "minimum"
										? check.score >= check.threshold
										: check.score <= check.threshold;
									return (
										<div className="contents" key={check.signal}>
											<dt>{CHECKS[check.signal]}</dt>
											<dd className="m-0">
												{percent(check.score)} ({check.comparison} {percent(check.threshold)};{" "}
												{passed ? "met" : "not met"})
											</dd>
										</div>
									);
								})}
							</dl>
						</section>
					)}
					<dl className="m-0 mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
						{Object.entries(analysis!.answers).map(([key, value]) => (
							<div className="contents" key={key}>
								<dt>{questionName(key)}</dt>
								<dd className="m-0">{answerText(value)}</dd>
							</div>
						))}
					</dl>
				</>
			)}
		</section>
	);
}
