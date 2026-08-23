import { useState } from "react";

import { canCancelJob, currentJobs, useJobs } from "./jobs";

import type { Job } from "@chopin/protocol";
import type { JobStore } from "./jobs";

export type BackgroundWorkProps = {
	store: JobStore;
	connected: boolean;
	canEdit: boolean;
	headingId?: string;
};

const INTERRUPTION_REASONS: Record<string, string> = {
	"attempt-error": "Research worker failed unexpectedly",
	"attempt-timeout": "Attempt timed out",
	"credential-rotated": "Planner credentials changed",
	"heartbeat-lost": "Runner heartbeat was lost",
	"hosted-search-sources-unverifiable": "Hosted web search returned unverifiable sources",
	"owner-unavailable": "Planner owner became unavailable",
	"private-analysis-failed": "Private document analysis failed",
	"public-research-failed": "Public web research failed",
	"public-session-failed": "Copilot research session failed",
	"research-result-invalid": "Research returned an invalid result",
	"research-result-missing": "Research returned no structured result",
	"research-permission-denied": "Copilot web search permission was denied",
	"research-source-mismatch": "Submitted sources did not match search results",
	"research-sources-unverifiable": "Search results had no verifiable source metadata",
	"report-synthesis-failed": "Research report synthesis failed",
	"source-validation-failed": "Research sources could not be verified",
	"web-search-failed": "Copilot web search failed",
	"web-search-not-invoked": "Copilot did not invoke web search",
	"web-search-unavailable": "Copilot web search is unavailable",
};

function interruptionReason(reason: string | undefined): string {
	return reason && Object.hasOwn(INTERRUPTION_REASONS, reason)
		? INTERRUPTION_REASONS[reason]!
		: "Worker stopped unexpectedly";
}

export function visibleProgress(
	job: Job.View,
): Array<Job.Progress & { status: string; detail?: string }> {
	let latest = new Map<string, Job.Progress>();
	for (let entry of job.progress) latest.set(`${entry.attempt}:${entry.stage}`, entry);
	let activeRevision = job.state === "running"
		? Math.max(
			0,
			...[...latest.values()].filter(entry =>
				entry.attempt === job.attempts && entry.state === "started"
			).map(entry => entry.revision),
		)
		: 0;
	return [...latest.values()].map(entry => ({
		...entry,
		status: entry.state === "completed"
			? "Completed"
			: entry.revision === activeRevision
			? "In progress"
			: "Interrupted",
		...(entry.state === "interrupted"
			? { detail: interruptionReason(entry.reason) }
			: {}),
	}));
}

function result(detail: Job.Detail | undefined): { title: string; summary: string } | undefined {
	let value = detail?.artifact?.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let artifact = value as Record<string, unknown>;
	if (typeof artifact.summary === "string") {
		return { title: "Document summary", summary: artifact.summary };
	}
	let report = artifact.report;
	if (!report || typeof report !== "object" || Array.isArray(report)) return undefined;
	let body = report as Record<string, unknown>;
	return typeof body.title === "string" && typeof body.summary === "string"
		? { title: body.title, summary: body.summary }
		: undefined;
}

function BackgroundJob(
	{ canEdit, connected, job, store }: {
		canEdit: boolean;
		connected: boolean;
		job: Job.View;
		store: JobStore;
	},
) {
	let snapshot = useJobs(store);
	let [open, setOpen] = useState(false);
	let [error, setError] = useState<string>();
	let detail = snapshot.details[job.id];
	let artifact = result(detail);
	let progress = visibleProgress(job);
	let subject = job.type === "research-question"
		? `Research question: ${job.subject ?? job.targetKey.split(":").at(-1)}`
		: "Document summary";
	let toggle = () => {
		setOpen(value => !value);
		if (!detail) void store.detail(job.id).catch(() => {});
	};
	return (
		<article className="plan-background-job">
			<div className="plan-background-job-heading">
				<strong>{subject}</strong>
				<span>{job.state}{job.reason ? ` · ${job.reason}` : ""}</span>
			</div>
			<div className="plan-background-job-actions">
				{job.state === "completed" && (
					<button
						aria-expanded={open}
						aria-label={`${open ? "Hide" : "Read"} result for ${subject}`}
						data-press="wide"
						onClick={toggle}
						type="button"
					>
						{open ? "Hide result" : "Read result"}
					</button>
				)}
				{canEdit && canCancelJob(job) && (
					<button
						aria-label={`Cancel ${subject}`}
						data-press="wide"
						disabled={!connected || !!snapshot.pending[job.id]}
						onClick={() => {
							setError(undefined);
							void store.cancel(job).catch(err =>
								setError(err instanceof Error ? err.message : "Could not cancel background work.")
							);
						}}
						type="button"
					>
						Cancel
					</button>
				)}
			</div>
			{progress.length > 0 && (
				<div className="plan-background-job-progress-log">
					<strong>Progress</strong>
					<ol aria-label={`Progress for ${subject}`}>
						{progress.map(entry => (
							<li key={`${entry.attempt}:${entry.stage}`}>
								<span>{entry.label}</span>
								<span className="plan-background-job-progress-state">
									{job.attempts > 1 ? `Attempt ${entry.attempt} · ` : ""}
									{entry.status}
									{entry.detail ? ` · ${entry.detail}` : ""}
								</span>
							</li>
						))}
					</ol>
				</div>
			)}
			{open && artifact && (
				<div className="plan-background-job-result">
					<h3>{artifact.title}</h3>
					<p>{artifact.summary}</p>
				</div>
			)}
			{open && detail && !artifact && <p>Result is unavailable.</p>}
			{error && <p role="status">{error}</p>}
		</article>
	);
}

export function BackgroundWork({ store, connected, canEdit, headingId }: BackgroundWorkProps) {
	let snapshot = useJobs(store);
	let jobs = currentJobs(snapshot.jobs);
	return (
		<div className="plan-background-work">
			<h2 id={headingId} tabIndex={-1}>Background Work</h2>
			{!snapshot.ready && <p>Loading background work…</p>}
			{snapshot.error && <p role="status">{snapshot.error}</p>}
			{snapshot.ready && jobs.length === 0 && <p>No background work yet.</p>}
			{jobs.map(job => (
				<BackgroundJob
					canEdit={canEdit}
					connected={connected}
					job={job}
					key={job.id}
					store={store}
				/>
			))}
			{snapshot.truncated && <p>Only the most recent background work is shown.</p>}
		</div>
	);
}
