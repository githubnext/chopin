import { useState } from "react";

import type { ConversationPlan } from "@chopin/protocol";

export function PlannerJobDiagnostics({ canEdit, jobs, onRetryJob, titled = true }: {
	canEdit: boolean;
	jobs: ConversationPlan.Job[];
	onRetryJob?: (jobId: string) => Promise<void>;
	titled?: boolean;
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
		<div
			aria-label="Planner jobs"
			className={titled ? "mt-2 hairline-t pt-2" : "mt-1"}
			role="group"
		>
			{titled && <strong>Planner jobs</strong>}
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

const FAILURES: Record<ConversationPlan.JobKind, string> = {
	heading: "Chopin couldn’t update the document heading",
	refine: "Chopin couldn’t rewrite the card wording",
	suggest: "Chopin couldn’t suggest an answer",
	prose: "Chopin couldn’t write this decision into the document",
};

/** Failed follow-up work in plain words, with the job details left to Diagnostics. */
export function FailedJobs({ canEdit, jobs, onRetryJob }: {
	canEdit: boolean;
	jobs: ConversationPlan.Job[];
	onRetryJob?: (jobId: string) => Promise<void>;
}) {
	let [retrying, setRetrying] = useState<string>();
	let [error, setError] = useState("");
	let retry = async (jobId: string) => {
		if (!onRetryJob || retrying) return;
		setRetrying(jobId);
		setError("");
		try {
			await onRetryJob(jobId);
		} catch {
			setError("Couldn’t retry. Try again when connected.");
		} finally {
			setRetrying(undefined);
		}
	};
	return (
		<div aria-label="Unfinished work" className="mt-3 flex flex-col gap-2" role="group">
			{jobs.map(job => (
				<div className="flex items-center gap-2 text-sm" key={job.id}>
					<span className="min-w-0 flex-1">{FAILURES[job.kind]}</span>
					{canEdit && onRetryJob && (
						<button
							aria-busy={retrying === job.id || undefined}
							aria-label={`Retry ${job.kind} job`}
							className="btn btn-sm btn-secondary shrink-0"
							disabled={retrying !== undefined}
							onClick={() => void retry(job.id)}
							type="button"
						>
							{retrying === job.id ? "Retrying…" : "Retry"}
						</button>
					)}
				</div>
			))}
			{error && <p className="m-0 text-destructive-ink" role="alert">{error}</p>}
		</div>
	);
}
