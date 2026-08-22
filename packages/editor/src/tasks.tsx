import { useState } from "react";

import { canCancelJob, currentJobs, useJobs } from "./jobs";

import type { Job } from "@chopin/protocol";
import type { JobStore } from "./jobs";

export type TasksProps = {
	store: JobStore;
	connected: boolean;
	canEdit: boolean;
	headingId?: string;
};

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

function Task(
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
	let subject = job.type === "research-question"
		? `Research question: ${job.subject ?? job.targetKey.split(":").at(-1)}`
		: "Document summary";
	let toggle = () => {
		setOpen(value => !value);
		if (!detail) void store.detail(job.id).catch(() => {});
	};
	return (
		<article className="plan-task">
			<div className="plan-task-heading">
				<strong>{subject}</strong>
				<span>{job.state}{job.reason ? ` · ${job.reason}` : ""}</span>
			</div>
			<div className="plan-task-actions">
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
								setError(err instanceof Error ? err.message : "Could not cancel task.")
							);
						}}
						type="button"
					>
						Cancel
					</button>
				)}
			</div>
			{open && artifact && (
				<div className="plan-task-result">
					<h3>{artifact.title}</h3>
					<p>{artifact.summary}</p>
				</div>
			)}
			{open && detail && !artifact && <p>Result is unavailable.</p>}
			{error && <p role="status">{error}</p>}
		</article>
	);
}

export function Tasks({ store, connected, canEdit, headingId }: TasksProps) {
	let snapshot = useJobs(store);
	let jobs = currentJobs(snapshot.jobs);
	return (
		<div className="plan-tasks">
			<h2 id={headingId} tabIndex={-1}>Tasks &amp; Progress</h2>
			{!snapshot.ready && <p>Loading background work…</p>}
			{snapshot.error && <p role="status">{snapshot.error}</p>}
			{snapshot.ready && jobs.length === 0 && <p>No background work yet.</p>}
			{jobs.map(job => (
				<Task canEdit={canEdit} connected={connected} job={job} key={job.id} store={store} />
			))}
			{snapshot.truncated && <p>Only the most recent background work is shown.</p>}
		</div>
	);
}
