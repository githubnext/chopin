import { useState } from "react";

import type { ConversationPlan } from "@chopin/protocol";

export function PlannerJobDiagnostics({ canEdit, jobs, onRetryJob }: {
	canEdit: boolean;
	jobs: ConversationPlan.Job[];
	onRetryJob?: (jobId: string) => Promise<void>;
}) {
	let [retrying, setRetrying] = useState<string>();
	let [error, setError] = useState("");
	let retry = async (jobId: string) => {
		if (!canEdit || !onRetryJob || retrying) return;
		setRetrying(jobId);
		setError("");
		try {
			await onRetryJob(jobId);
		} catch {
			setError("The Planner job could not be retried. Try again when connected.");
		} finally {
			setRetrying(undefined);
		}
	};

	if (jobs.length === 0) return null;

	return (
		<div className="mt-2 hairline-t pt-2" aria-label="Planner jobs" role="group">
			<strong>Planner jobs</strong>
			{jobs.map(job => (
				<div className="mt-1" key={job.id}>
					<p className="m-0">
						{job.kind} · {job.status}
						{job.reason ? ` — ${job.reason}` : ""}
					</p>
					{job.output && (
						<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
							{job.output}
						</pre>
					)}
					{job.status === "failed" && canEdit && onRetryJob && (
						<button
							aria-busy={retrying === job.id || undefined}
							className="btn btn-sm btn-secondary mt-1"
							disabled={retrying !== undefined}
							onClick={() => void retry(job.id)}
							type="button"
						>
							{retrying === job.id ? `Retrying ${job.kind} job…` : `Retry ${job.kind} job`}
						</button>
					)}
				</div>
			))}
			{error && <p className="m-0 mt-1 text-destructive-ink" role="alert">{error}</p>}
		</div>
	);
}

export function JobsOnlyDiagnostics({ canEdit, jobs, onClose, onRetryJob }: {
	canEdit: boolean;
	jobs: ConversationPlan.Job[];
	onClose: () => void;
	onRetryJob?: (jobId: string) => Promise<void>;
}) {
	return (
		<>
			<div className="flex items-center justify-end gap-2">
				<button
					aria-label="Close Planner jobs"
					className="btn btn-sm btn-ghost"
					onClick={onClose}
					type="button"
				>
					Close
				</button>
			</div>
			<PlannerJobDiagnostics canEdit={canEdit} jobs={jobs} onRetryJob={onRetryJob} />
		</>
	);
}
