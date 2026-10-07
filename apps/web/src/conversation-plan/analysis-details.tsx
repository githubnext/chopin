/** The message details popover body. Loaded on first open to keep Chat's chunk small. */

import { CloseIcon, WarningIcon } from "@chopin/icons";

import { AnalysisDiagnostics, AnalysisOverview } from "./analysis-overview";
import { FailedJobs, PlannerJobDiagnostics } from "./planner-job-diagnostics";
import { changeText } from "./outcome";
import { motionImmediately } from "../motion-input";
import { ResearchDiagnostics } from "./research-diagnostics";

import type { ConversationPlan } from "@chopin/protocol";
import type { ExcerptCorrectionAction } from "./analysis-action";
import type { CardLink } from "./links";
import type { Lane, MessageOutcome } from "./outcome";

function Header({ heading, label, onClose, tone }: {
	heading: string;
	label: string;
	onClose: () => void;
	tone: MessageOutcome["tone"];
}) {
	return (
		<div className="flex items-center gap-2">
			{tone === "warning"
				? <WarningIcon aria-hidden="true" className="shrink-0 text-warning-icon" size={14} />
				: (
					<span
						aria-hidden="true"
						className={`size-2 shrink-0 rounded-full ${
							tone === "success" ? "bg-success" : "bg-neutral-graphic"
						}`}
					/>
				)}
			<h2 className="m-0 min-w-0 flex-1 text-sm font-medium text-text-primary">{heading}</h2>
			<button
				aria-label={label}
				className="btn btn-icon btn-ghost -my-1 -me-1 shrink-0"
				onClick={onClose}
				type="button"
			>
				<CloseIcon aria-hidden="true" size={14} />
			</button>
		</div>
	);
}

function summary(outcome: MessageOutcome): string {
	if (outcome.failed.includes("decision")) {
		return "Something went wrong while reading this message, so nothing was added to a decision.";
	}
	if (outcome.changes.length > 0) return "";
	if (outcome.research === "offered") {
		return "Chopin suggested researching this. Nothing was added to a decision.";
	}
	if (outcome.research === "failed") return "The research check didn’t finish.";
	if (outcome.pending) return "Chopin is still reading this message.";
	return "Nothing in this message changed a decision.";
}

export function AnalysisDetails({
	analysis,
	canEdit,
	jobs,
	jobsOnly,
	links,
	messageId,
	messageText,
	onAddExcerpt,
	onCard,
	onClose,
	onRetry,
	onRetryJob,
	outcome,
	research,
	researchPending,
	retrying,
	error,
	state,
}: {
	analysis?: ConversationPlan.AnalysisRecord;
	canEdit: boolean;
	jobs: ConversationPlan.Job[];
	jobsOnly: boolean;
	links: CardLink[];
	messageId: string;
	messageText: string;
	onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
	onCard: (link: CardLink) => void;
	onClose: () => void;
	onRetry: (lane: Lane) => void;
	onRetryJob?: (jobId: string) => Promise<void>;
	outcome?: MessageOutcome;
	research?: ConversationPlan.ResearchAnalysis;
	researchPending: boolean;
	retrying?: Lane;
	error: string;
	state?: ConversationPlan.State;
}) {
	if (jobsOnly || !outcome) {
		return (
			<>
				<Header
					heading="Planner jobs"
					label="Close Planner jobs"
					onClose={onClose}
					tone="neutral"
				/>
				<PlannerJobDiagnostics
					canEdit={canEdit}
					jobs={jobs}
					onRetryJob={onRetryJob}
					titled={false}
				/>
			</>
		);
	}
	let lines = outcome.changes.length
		? outcome.changes.map(change => changeText(change, messageText))
		: [summary(outcome)];
	let failedJobs = jobs.filter(job => job.status === "failed");
	let hasDiagnostics = !!analysis || !!research || researchPending || jobs.length > 0;

	return (
		<>
			<Header
				heading={outcome.heading}
				label="Close analysis"
				onClose={onClose}
				tone={outcome.tone}
			/>
			{lines.map(line => <p className="m-0 mt-2 text-sm leading-5" key={line}>{line}</p>)}
			<AnalysisOverview
				analysis={analysis}
				canEdit={canEdit}
				links={links}
				messageId={messageId}
				messageText={messageText}
				onAddExcerpt={onAddExcerpt}
				onCard={onCard}
				state={state}
			/>
			{outcome.research === "offered" && outcome.changes.length > 0 && (
				<p className="m-0 mt-2 text-sm text-text-tertiary">Chopin also suggested research.</p>
			)}
			{failedJobs.length > 0 && (
				<FailedJobs canEdit={canEdit} jobs={failedJobs} onRetryJob={onRetryJob} />
			)}
			{canEdit && outcome.failed.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2">
					{outcome.failed.map(lane => (
						<button
							className="btn btn-sm btn-secondary"
							disabled={retrying !== undefined}
							key={lane}
							onClick={() => onRetry(lane)}
							type="button"
						>
							{lane === "decision" ? "Retry analysis" : "Retry research check"}
						</button>
					))}
				</div>
			)}
			{error && <p className="m-0 mt-1 text-sm text-destructive-ink" role="alert">{error}</p>}
			{hasDiagnostics && (
				<details
					className="mt-3 hairline-t pt-2"
					onToggle={event => {
						if (!event.currentTarget.open) return;
						event.currentTarget.scrollIntoView({
							behavior: motionImmediately() ? "auto" : "smooth",
							block: "nearest",
						});
					}}
				>
					<summary className="cursor-pointer text-sm text-text-tertiary hover:text-text-secondary">
						Diagnostics
					</summary>
					<AnalysisDiagnostics analysis={analysis} />
					<ResearchDiagnostics analysis={research} pending={researchPending} />
					<PlannerJobDiagnostics canEdit={false} jobs={jobs} />
				</details>
			)}
		</>
	);
}
