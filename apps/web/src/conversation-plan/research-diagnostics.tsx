import { useRef, useState } from "react";
import type { ConversationPlan } from "@chopin/protocol";
import { answerText, questionName } from "./analysis-labels";

export function ResearchDiagnostics({ analysis, pending, canEdit, onRetry }: {
	analysis?: ConversationPlan.ResearchAnalysis;
	pending: boolean;
	canEdit: boolean;
	onRetry: (id: string, actionId: string, lane?: "decision" | "research") => Promise<void>;
}) {
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let action = useRef<string | undefined>(undefined);
	if (!analysis && !pending) return null;
	return (
		<section className="mt-3 hairline-t pt-3" aria-label="Research analysis">
			<h3 className="m-0 text-sm font-medium">Research analysis</h3>
			{pending ? <p className="m-0 text-sm">Waiting for research analysis</p> : (
				<>
					<p className="m-0 text-sm">{analysis!.policyGate}</p>
					<p className="m-0 text-xs text-text-tertiary">
						Model {analysis!.modelVersion} · Questions {analysis!.questionSetVersion} ·{" "}
						{analysis!.latencyMs} ms
					</p>
					<details className="mt-2">
						<summary>Research judgments</summary>
						<dl className="m-0 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
							{Object.entries(analysis!.answers).map(([key, value]) => (
								<div className="contents" key={key}>
									<dt>{questionName(key)}</dt>
									<dd className="m-0">{answerText(value)}</dd>
								</div>
							))}
						</dl>
					</details>
				</>
			)}
			{analysis?.status === "failed" && canEdit && (
				<button
					className="btn btn-sm btn-secondary mt-2"
					disabled={busy}
					type="button"
					onClick={() => {
						let id = action.current ??= crypto.randomUUID();
						setBusy(true);
						setError("");
						void onRetry(analysis.messageId, id, "research").then(() => {
							action.current = undefined;
						}).catch(() => setError("Could not retry research analysis.")).finally(() =>
							setBusy(false)
						);
					}}
				>
					Retry research analysis
				</button>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
