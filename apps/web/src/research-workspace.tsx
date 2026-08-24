import { useCallback, useEffect, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { rememberChannel } from "./channel-recovery";
import { newestDocumentMetadata } from "./document-actions";
import { DocumentActionsMenu } from "./document-actions-menu";
import { useNavigationDocument } from "./navigation-shell";
import {
	activeResearchJob,
	artifactFromJob,
	beginResearchSubmission,
	completeResearchSubmission,
	editResearchSubmission,
	latestResearchJobRevision,
	mergeResearchWorkspaceDetail,
} from "./research-workspace-model";
import { TerminalAlert } from "./terminal-alert";
import { Wire } from "./wire";

import "./research-workspace.css";

import type { Job, Research, Session } from "@chopin/protocol";
import type { HostedWorkspaceProps } from "./hosted";
import type { DocumentMetadata } from "./document-actions";
import type {
	ResearchAnswerArtifact,
	ResearchContinuationArtifact,
	ResearchInitialArtifact,
	ResearchSource,
	ResearchSubmission,
} from "./research-workspace-model";
import type { Status } from "./wire";

type ResearchWorkspaceProps = HostedWorkspaceProps & { workspaceId: string };
type ManagedHello = Session.Hello & { archivedAt?: string; canManage: boolean };
type ManagedChannel = Session.Channel & { archivedAt?: string; canManage: boolean };
type ManagedAccess = Session.Access & { canManage: boolean };
type WorkspaceMetadata = DocumentMetadata;

function timestamp(value: string): string {
	let date = new Date(value);
	return Number.isNaN(date.getTime())
		? "Unknown time"
		: new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date);
}

function Time({ value }: { value: string }) {
	return <time dateTime={value}>{timestamp(value)}</time>;
}

function parentChannel(
	room: string,
	repository: Api.Repository,
	metadata: { title: string; slug: string },
): Api.ResearchParentChannel {
	return {
		id: room,
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: metadata.title,
		slug: metadata.slug,
	};
}

function answerArtifact(
	workspaceId: string,
	turn: Api.ResearchWorkspaceTurn,
): ResearchAnswerArtifact | undefined {
	let artifact = artifactFromJob(turn.answer);
	return artifact?.workspaceId === workspaceId && artifact.turnId === turn.id
			&& artifact.kind === turn.kind
		? artifact
		: undefined;
}

function activeTurn(turn: Api.ResearchWorkspaceTurn): boolean {
	return activeResearchJob(turn.evidence) || activeResearchJob(turn.answer);
}

function currentJob(turn: Api.ResearchWorkspaceTurn): Job.Detail | undefined {
	if (turn.answer) return turn.answer;
	return turn.evidence;
}

const STAGE_LABELS: Record<string, string> = {
	"public-web": "Searching the public web",
	"private-document": "Analyzing the private document",
	"report-synthesis": "Writing the report",
	"private-answer": "Drafting the answer",
};

function jobLabel(detail: Job.Detail | undefined): string {
	if (!detail) return "Queued";
	switch (detail.job.state) {
		case "pending":
			return "Queued";
		case "paused":
			return "Paused";
		case "running": {
			let progress = detail.job.progress.toReversed().find(item => item.state === "started");
			return progress ? STAGE_LABELS[progress.stage] ?? "Working" : "Working";
		}
		case "completed":
			return "Completed";
		case "failed":
			return "Could not complete";
		case "cancelled":
			return "Cancelled";
		case "superseded":
			return "Replaced by newer work";
	}
}

function JobProgress(
	{
		canCancel,
		onCancel,
		turn,
	}: {
		canCancel: boolean;
		onCancel: () => void;
		turn: Api.ResearchWorkspaceTurn;
	},
) {
	let detail = currentJob(turn);
	let active = activeTurn(turn);
	let stages = new Map<string, Job.Progress>();
	for (let progress of detail?.job.progress ?? []) stages.set(progress.stage, progress);
	return (
		<div className="research-job-status" data-state={detail?.job.state ?? "pending"}>
			<div className="flex min-w-0 items-center justify-between gap-3">
				<p className="min-w-0 text-sm font-medium" role="status">{jobLabel(detail)}</p>
				{active && (
					<button
						aria-label="Cancel active research turn"
						className="btn btn-sm btn-secondary shrink-0"
						disabled={!canCancel}
						onClick={onCancel}
						type="button"
					>
						Cancel
					</button>
				)}
			</div>
			{stages.size > 0 && (
				<ul className="research-progress-list" aria-label="Research progress">
					{[...stages.values()].map(progress => (
						<li key={progress.stage}>
							<span>{STAGE_LABELS[progress.stage] ?? "Research work"}</span>
							<span>
								{progress.state === "completed"
									? "Complete"
									: progress.state === "interrupted"
									? "Interrupted"
									: "In progress"}
							</span>
						</li>
					))}
				</ul>
			)}
			{detail && (
				<p className="mt-2 text-sm text-text-quaternary">
					Updated <Time value={detail.job.updatedAt} />
				</p>
			)}
		</div>
	);
}

function SourceCitations(
	{ sources, urls }: { sources: ResearchSource[]; urls: string[] },
) {
	return (
		<span className="research-citations" aria-label="Citations">
			{urls.map(url => {
				let index = sources.findIndex(source => source.url === url);
				let source = sources[index];
				if (!source) return null;
				return (
					<a
						aria-label={`Source ${index + 1}: ${source.title}`}
						className="research-citation research-control"
						href={source.url}
						key={source.url}
						rel="noopener noreferrer"
						target="_blank"
					>
						[{index + 1}]
					</a>
				);
			})}
		</span>
	);
}

function Sources({ sources }: { sources: ResearchSource[] }) {
	return (
		<ol className="research-sources">
			{sources.map((source, index) => (
				<li key={source.url}>
					<span aria-hidden="true">[{index + 1}]</span>
					<a
						className="research-source-link research-control"
						href={source.url}
						rel="noopener noreferrer"
						target="_blank"
					>
						{source.title}
					</a>
				</li>
			))}
		</ol>
	);
}

function GeneratedReport(
	{
		artifact,
		createdAt,
	}: {
		artifact: ResearchInitialArtifact;
		createdAt: string;
	},
) {
	let { report, sources } = artifact;
	return (
		<article className="research-report" aria-labelledby="generated-report-heading">
			<div className="research-section-heading">
				<div>
					<p className="research-kicker">Generated report</p>
					<h2 id="generated-report-heading">{report.title}</h2>
				</div>
				<p className="text-sm text-text-quaternary">
					Generated <Time value={createdAt} />
				</p>
			</div>
			<p className="research-report-summary">{report.summary}</p>
			<section>
				<h3>Findings</h3>
				{report.findings.length > 0
					? (
						<ol className="research-findings">
							{report.findings.map((finding, index) => (
								<li key={`${index}:${finding.text}`}>
									<span>{finding.text}</span>
									<SourceCitations sources={sources} urls={finding.sourceUrls} />
								</li>
							))}
						</ol>
					)
					: <p className="research-empty">No findings were reported.</p>}
			</section>
			<section>
				<h3>Caveats</h3>
				{report.caveats.length > 0
					? (
						<ul className="research-caveats">
							{report.caveats.map((caveat, index) => <li key={`${index}:${caveat}`}>{caveat}</li>)}
						</ul>
					)
					: <p className="research-empty">No caveats were reported.</p>}
			</section>
			<section>
				<h3>Sources</h3>
				{sources.length > 0
					? <Sources sources={sources} />
					: <p className="research-empty">No public sources were used.</p>}
			</section>
			<footer className="research-provenance-note">
				Document revision {artifact.documentRevision}{" "}
				was analyzed privately and separately from public web evidence.
			</footer>
		</article>
	);
}

function unavailableReason(
	connected: boolean,
	canEdit: boolean,
	agent: boolean,
	backgroundJobs: boolean,
	webResearch: boolean,
): string | undefined {
	if (!canEdit) return "Repository write access is required.";
	if (!agent) return "Research execution is unavailable in this deployment.";
	if (!backgroundJobs) return "Background work is unavailable in this deployment.";
	if (!webResearch) return "Public web research is unavailable in this deployment.";
	if (!connected) return "Reconnect to start public web research.";
	return undefined;
}

function DraftConfirmation(
	{
		backgroundJobs,
		canEdit,
		connected,
		agent,
		onSaved,
		webResearch,
		workspace,
	}: {
		agent: boolean;
		backgroundJobs: boolean;
		canEdit: boolean;
		connected: boolean;
		onSaved: (detail: Api.ResearchWorkspaceDetail) => void;
		webResearch: boolean;
		workspace: Research.WorkspaceSummary;
	},
) {
	let [submission, setSubmission] = useState<ResearchSubmission>({
		text: workspace.proposedQuestion,
	});
	let [submitting, setSubmitting] = useState(false);
	let [error, setError] = useState<unknown>();
	let reason = unavailableReason(connected, canEdit, agent, backgroundJobs, webResearch);

	let submit = async () => {
		if (submitting || reason || !submission.text.trim()) return;
		let next = beginResearchSubmission(submission, "confirm");
		setSubmission(next);
		setSubmitting(true);
		setError(undefined);
		try {
			let detail = await Api.confirmResearchWorkspace(
				workspace.channelId,
				workspace.id,
				next.submittedText,
				next.requestId,
			);
			setSubmission(completeResearchSubmission());
			onSaved(detail);
		} catch (failure) {
			setError(failure);
			setSubmitting(false);
		}
	};

	return (
		<section className="research-draft" aria-labelledby="research-draft-heading">
			<p className="research-kicker">Private draft</p>
			<h2 id="research-draft-heading">Review before searching</h2>
			<label htmlFor="research-confirm-query">Research question</label>
			<textarea
				className="field"
				id="research-confirm-query"
				maxLength={4096}
				onChange={event =>
					setSubmission(current => editResearchSubmission(current, event.target.value))}
				readOnly={!canEdit}
				value={submission.text}
			/>
			<p className="research-disclosure" id="research-confirm-disclosure">
				The exact text you submit is disclosed to public web search. Private document context is
				analyzed separately and is not sent as search input.
			</p>
			{reason && <p className="research-disabled-reason">{reason}</p>}
			{error !== undefined && (
				<TerminalAlert className="research-error">
					{error instanceof Error ? error.message : "Could not start public web research."}
				</TerminalAlert>
			)}
			<button
				aria-describedby="research-confirm-disclosure"
				className="btn btn-md btn-primary"
				disabled={submitting || !!reason || !submission.text.trim()}
				onClick={() => void submit()}
				type="button"
			>
				Search public web
			</button>
		</section>
	);
}

function continuationArtifact(
	workspaceId: string,
	turn: Api.ResearchWorkspaceTurn,
): ResearchContinuationArtifact | undefined {
	let artifact = answerArtifact(workspaceId, turn);
	return artifact?.kind === "follow-up" || artifact?.kind === "search-more"
		? artifact
		: undefined;
}

function ResearchThread(
	{
		agent,
		backgroundJobs,
		canCancel,
		canEdit,
		connected,
		detail,
		onCancel,
		onSaved,
		webResearch,
	}: {
		agent: boolean;
		backgroundJobs: boolean;
		canCancel: boolean;
		canEdit: boolean;
		connected: boolean;
		detail: Api.ResearchWorkspaceDetail;
		onCancel: (turnId: string) => void;
		onSaved: (detail: Api.ResearchWorkspaceDetail) => void;
		webResearch: boolean;
	},
) {
	let turns = detail.turns.filter(turn => turn.kind !== "initial");
	let active = detail.turns.some(activeTurn);
	let [submission, setSubmission] = useState<ResearchSubmission>({ text: "" });
	let [submitting, setSubmitting] = useState(false);
	let [error, setError] = useState<unknown>();
	let canAsk = connected && canEdit && backgroundJobs && agent;
	let canSearch = canAsk && webResearch;

	let submit = async (kind: "follow-up" | "search-more") => {
		let enabled = kind === "follow-up" ? canAsk : canSearch;
		if (!enabled || active || submitting || !submission.text.trim()) return;
		let next = beginResearchSubmission(submission, kind);
		setSubmission(next);
		setSubmitting(true);
		setError(undefined);
		try {
			let saved = await Api.appendResearchWorkspaceTurn(
				detail.workspace.channelId,
				detail.workspace.id,
				kind,
				next.submittedText,
				next.requestId,
			);
			setSubmission(completeResearchSubmission());
			onSaved(saved);
			setSubmitting(false);
		} catch (failure) {
			setError(failure);
			setSubmitting(false);
		}
	};

	return (
		<section className="research-thread" aria-labelledby="research-thread-heading">
			<div className="research-section-heading">
				<div>
					<p className="research-kicker">Shared history</p>
					<h2 id="research-thread-heading">Research thread</h2>
				</div>
				<span className="research-turn-count">
					{turns.length} {turns.length === 1 ? "turn" : "turns"}
				</span>
			</div>
			{turns.length === 0 && (
				<p className="research-empty-thread">
					Ask a follow-up or explicitly search for more evidence.
				</p>
			)}
			<ol className="research-turns">
				{turns.map(turn => {
					let artifact = continuationArtifact(detail.workspace.id, turn);
					let member = detail.messages.find(message =>
						message.turnId === turn.id && message.authorKind === "member"
					);
					let job = currentJob(turn);
					return (
						<li className="research-turn" key={turn.id}>
							<header>
								<span>{turn.kind === "search-more" ? "Public web search" : "Follow-up"}</span>
								<Time value={turn.createdAt} />
							</header>
							<p className="research-turn-author">
								{member?.userHandle ? `@${member.userHandle}` : "Workspace member"}
							</p>
							<p className="research-turn-question">{turn.question}</p>
							{artifact && (
								<div className="research-turn-answer">
									<p>{artifact.answer.text}</p>
									<SourceCitations
										sources={artifact.sources}
										urls={artifact.answer.sourceUrls}
									/>
								</div>
							)}
							{!artifact && job?.job.state === "completed" && (
								<TerminalAlert className="research-error">
									The completed answer could not be displayed safely.
								</TerminalAlert>
							)}
							{!artifact && (
								<JobProgress
									canCancel={canCancel}
									onCancel={() => onCancel(turn.id)}
									turn={turn}
								/>
							)}
						</li>
					);
				})}
			</ol>
			<div className="research-composer">
				<label htmlFor="research-follow-up">Continue the research</label>
				<textarea
					className="field"
					id="research-follow-up"
					maxLength={4096}
					onChange={event =>
						setSubmission(current => editResearchSubmission(current, event.target.value))}
					placeholder="Ask a focused follow-up"
					readOnly={!canEdit}
					value={submission.text}
				/>
				<p className="research-disclosure" id="research-follow-up-disclosure">
					Ask from research uses the existing report and private document context. It does not
					search the web.
				</p>
				<div className="research-composer-actions">
					<button
						aria-describedby="research-follow-up-disclosure"
						className="btn btn-md btn-primary"
						disabled={!canAsk || active || submitting || !submission.text.trim()}
						onClick={() => void submit("follow-up")}
						type="button"
					>
						Ask from research
					</button>
					<div className="research-search-more">
						<button
							aria-describedby="research-search-more-disclosure"
							className="btn btn-md btn-secondary"
							disabled={!canSearch || active || submitting || !submission.text.trim()}
							onClick={() => void submit("search-more")}
							type="button"
						>
							Search more
						</button>
						<p className="research-disclosure" id="research-search-more-disclosure">
							Search more sends the exact text above to public web search. Private document context
							stays separate.
						</p>
					</div>
				</div>
				{active && (
					<p className="research-disabled-reason">
						Wait for the active turn to finish or cancel it.
					</p>
				)}
				{!canAsk && !active && (
					<p className="research-disabled-reason">
						{!canEdit
							? "Repository write access is required."
							: !connected
							? "Reconnect to continue the research."
							: "Research answers are unavailable in this deployment."}
					</p>
				)}
				{error !== undefined && (
					<TerminalAlert className="research-error">
						{error instanceof Error ? error.message : "Could not add the research turn."}
					</TerminalAlert>
				)}
			</div>
		</section>
	);
}

function connectionLabel(status: Status): string {
	switch (status) {
		case "connecting":
			return "Connecting";
		case "connected":
			return "Connected";
		case "reconnecting":
			return "Reconnecting";
		case "denied":
			return "Access changed";
		case "deleted":
			return "Document deleted";
		case "closed":
			return "Disconnected";
	}
}

export function ResearchWorkspace(
	{
		agent = true,
		archivedAt,
		canEdit,
		canManage,
		description,
		descriptionRevision,
		label,
		repository,
		room,
		slug,
		updatedAt,
		userId,
		workspaceId,
	}: ResearchWorkspaceProps,
) {
	let {
		onDocumentAction,
		onDocumentChanged,
		onDocumentDeleted,
		onRepositoryAccessChanged,
		onResearchWorkspaceChanged,
		onResearchWorkspaceLoaded,
		onResearchWorkspacesRefresh,
	} = useNavigationDocument();
	let [detail, setDetail] = useState<Api.ResearchWorkspaceDetail>();
	let detailRef = useRef<Api.ResearchWorkspaceDetail | undefined>(undefined);
	let [error, setError] = useState<unknown>();
	let [refreshing, setRefreshing] = useState(false);
	let [status, setStatus] = useState<Status>("connecting");
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit && !archivedAt);
	let [effectiveCanManage, setEffectiveCanManage] = useState(canManage);
	let [deleted, setDeleted] = useState(false);
	let [capabilities, setCapabilities] = useState({ backgroundJobs: false, webResearch: false });
	let [metadata, setMetadata] = useState<WorkspaceMetadata>({
		archivedAt,
		description,
		descriptionRevision,
		title: label,
		slug,
		updatedAt,
	});
	let metadataRef = useRef(metadata);
	let requestGeneration = useRef(0);
	let requestController = useRef<AbortController | undefined>(undefined);
	let acceptedRevision = useRef(-1);
	let researchRevision = useRef(-1);
	let jobRevision = useRef(-1);
	let [cancelling, setCancelling] = useState<string>();
	let [cancellationError, setCancellationError] = useState<unknown>();

	let accept = useCallback((next: Api.ResearchWorkspaceDetail) => {
		if (next.workspace.revision < acceptedRevision.current) return;
		acceptedRevision.current = next.workspace.revision;
		researchRevision.current = Math.max(researchRevision.current, next.workspace.revision);
		let merged = mergeResearchWorkspaceDetail(detailRef.current, next);
		detailRef.current = merged;
		setDetail(merged);
		setError(undefined);
		onResearchWorkspaceLoaded(
			parentChannel(room, repository, metadataRef.current),
			next.workspace,
		);
	}, [onResearchWorkspaceLoaded, repository, room]);

	let refresh = useCallback(async () => {
		let generation = ++requestGeneration.current;
		requestController.current?.abort();
		let controller = new AbortController();
		requestController.current = controller;
		setRefreshing(true);
		try {
			let next = await Api.researchWorkspace(room, workspaceId, controller.signal);
			if (controller.signal.aborted || generation !== requestGeneration.current) return;
			accept(next);
		} catch (failure) {
			if (controller.signal.aborted || generation !== requestGeneration.current) return;
			setError(failure);
		} finally {
			if (generation === requestGeneration.current) setRefreshing(false);
		}
	}, [accept, room, workspaceId]);

	let acceptMutation = useCallback((next: Api.ResearchWorkspaceDetail) => {
		requestGeneration.current++;
		requestController.current?.abort();
		setRefreshing(false);
		accept(next);
		if (
			researchRevision.current > next.workspace.revision
			|| jobRevision.current > latestResearchJobRevision(next)
		) void refresh();
	}, [accept, refresh]);

	let updateMetadata = useCallback((next: WorkspaceMetadata) => {
		let metadata = newestDocumentMetadata(metadataRef.current, next);
		metadataRef.current = metadata;
		setMetadata(metadata);
		rememberChannel(userId, { id: room, title: metadata.title, slug: metadata.slug }, repository);
		onDocumentChanged(room, metadata);
	}, [onDocumentChanged, repository, room, userId]);

	useEffect(() => {
		let next: WorkspaceMetadata = {
			archivedAt,
			description,
			descriptionRevision,
			title: label,
			slug,
			updatedAt,
		};
		next = newestDocumentMetadata(metadataRef.current, next);
		metadataRef.current = next;
		setMetadata(next);
		setEffectiveCanEdit(canEdit && !archivedAt);
		setEffectiveCanManage(canManage);
	}, [
		archivedAt,
		canEdit,
		canManage,
		description,
		descriptionRevision,
		label,
		room,
		slug,
		updatedAt,
	]);

	useEffect(() => {
		void refresh();
		return () => {
			requestGeneration.current++;
			requestController.current?.abort();
		};
	}, [refresh]);

	useEffect(() => {
		let socket = new Wire({
			channelId: room,
			onAuthenticationRequired: () => location.reload(),
			onDeleted: () => {
				setDeleted(true);
				onDocumentDeleted(room);
			},
			onStatus: next => {
				setStatus(next);
				if (next === "connected") void refresh();
			},
		});
		let off = [
			socket.on<ManagedHello>("session:hello", frame => {
				setEffectiveCanEdit(frame.canEdit && !frame.archivedAt);
				setEffectiveCanManage(frame.canManage);
				setCapabilities({
					backgroundJobs: frame.backgroundJobs,
					webResearch: frame.webResearch,
				});
				updateMetadata(frame);
				onRepositoryAccessChanged();
				onResearchWorkspacesRefresh(parentChannel(room, repository, metadataRef.current));
				void refresh();
			}),
			socket.on<ManagedAccess>("session:access", frame => {
				setEffectiveCanEdit(frame.canEdit);
				setEffectiveCanManage(frame.canManage);
				onRepositoryAccessChanged();
				void refresh();
			}),
			socket.on<ManagedChannel>("session:channel", frame => {
				if (frame.channelId !== room) return;
				setEffectiveCanEdit(!frame.archivedAt && frame.canManage);
				setEffectiveCanManage(frame.canManage);
				updateMetadata(frame);
				void refresh();
			}),
			socket.on<Research.Changed>("research:changed", frame => {
				onResearchWorkspaceChanged(
					parentChannel(room, repository, metadataRef.current),
					frame.workspaceId,
					frame.revision,
				);
				if (frame.workspaceId !== workspaceId || frame.revision <= researchRevision.current) return;
				researchRevision.current = frame.revision;
				void refresh();
			}),
			socket.on<Job.Changed>("job:changed", frame => {
				if (frame.revision <= jobRevision.current) return;
				jobRevision.current = frame.revision;
				void refresh();
			}),
		];
		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
		};
	}, [
		onDocumentDeleted,
		onResearchWorkspaceChanged,
		onResearchWorkspacesRefresh,
		onRepositoryAccessChanged,
		refresh,
		repository,
		room,
		updateMetadata,
		workspaceId,
	]);

	let workspaceArchivedAt = archivedAt ?? metadata.archivedAt;
	let workspaceCanEdit = effectiveCanEdit && !workspaceArchivedAt;
	let cancel = async (turnId: string) => {
		if (cancelling || status !== "connected" || !workspaceCanEdit) return;
		setCancelling(turnId);
		setCancellationError(undefined);
		try {
			acceptMutation(await Api.cancelResearchWorkspaceTurn(room, workspaceId, turnId));
		} catch (failure) {
			setCancellationError(failure);
		} finally {
			setCancelling(undefined);
		}
	};
	if (deleted) {
		return (
			<div className="research-route-state">
				<p role="status">This document was deleted.</p>
			</div>
		);
	}

	let parentHref = documentPath(repository.owner, repository.name, metadata.slug);
	let connected = status === "connected";
	let connection = connectionLabel(status);
	if (!detail && !error) {
		return (
			<div className="research-route-state">
				<p role="status">Opening research workspace...</p>
			</div>
		);
	}
	if (!detail) {
		return (
			<div className="research-route-state">
				<div className="research-route-failure">
					<h1>Cannot open research workspace</h1>
					<TerminalAlert className="research-route-alert">
						{error instanceof Error ? error.message : "The research workspace could not be loaded."}
					</TerminalAlert>
					<div className="flex flex-wrap gap-2">
						<button className="btn btn-md btn-primary" onClick={() => void refresh()} type="button">
							Try again
						</button>
						<a className="btn btn-md btn-secondary research-control" href={parentHref}>
							Back to document
						</a>
					</div>
				</div>
			</div>
		);
	}

	let initial = detail.turns.find(turn => turn.kind === "initial");
	let decoded = initial && answerArtifact(detail.workspace.id, initial);
	let report = decoded?.kind === "initial" ? decoded : undefined;
	let origin = detail.workspace.origin === "planner"
		? "Proposed by Planner"
		: "Started from sidebar";
	let workspaceStatus = detail.workspace.confirmedQuery === undefined
		? "Awaiting confirmation"
		: report
		? "Report complete"
		: initial
		? jobLabel(currentJob(initial))
		: "Preparing research";
	let canCancel = connected && workspaceCanEdit && !cancelling;

	return (
		<div className="research-workspace">
			<header className="research-header room-header">
				<div className="flex min-w-0 items-center">
					<a className="research-back-link research-control" href={parentHref}>
						Back to {metadata.title}
					</a>
					{workspaceArchivedAt && (
						<span className="document-status-badge document-read-only-status">
							Archived, read-only
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{effectiveCanManage && (
						<DocumentActionsMenu
							channel={{ archivedAt: workspaceArchivedAt, title: metadata.title }}
							className="btn btn-sm btn-ghost"
							onAction={action => onDocumentAction(room, action)}
							trigger={<span>Actions</span>}
						/>
					)}
					<div className="research-connection" data-status={status} role="status">
						<span aria-hidden="true" />
						{refreshing && connected ? "Refreshing" : connection}
					</div>
				</div>
			</header>
			<div className="research-scroll">
				<main className="research-layout">
					<section className="research-primary" aria-labelledby="research-title">
						<div className="research-title-block">
							<p className="research-kicker">Research workspace</p>
							<h1 id="research-title">{detail.workspace.title}</h1>
							<div className="research-meta" aria-label="Research provenance and status">
								<span>{origin}</span>
								<span>{workspaceStatus}</span>
								<span>
									Created <Time value={detail.workspace.createdAt} />
								</span>
								<span>
									Updated <Time value={detail.workspace.updatedAt} />
								</span>
							</div>
							{detail.workspace.confirmedQuery && (
								<div className="research-confirmed-query">
									<span>Confirmed public query</span>
									<p>{detail.workspace.confirmedQuery}</p>
								</div>
							)}
						</div>
						{detail.workspace.confirmedQuery === undefined
							? (
								<DraftConfirmation
									agent={agent}
									backgroundJobs={capabilities.backgroundJobs}
									canEdit={workspaceCanEdit}
									connected={connected}
									onSaved={acceptMutation}
									webResearch={capabilities.webResearch}
									workspace={detail.workspace}
								/>
							)
							: report && initial?.answer?.artifact
							? (
								<GeneratedReport
									artifact={report}
									createdAt={initial.answer.artifact.createdAt}
								/>
							)
							: initial
							? (
								<section
									className="research-report-pending"
									aria-labelledby="report-progress-heading"
								>
									<p className="research-kicker">Generated report</p>
									<h2 id="report-progress-heading">Research in progress</h2>
									<JobProgress
										canCancel={canCancel}
										onCancel={() => void cancel(initial.id)}
										turn={initial}
									/>
									{currentJob(initial)?.job.state === "completed" && (
										<TerminalAlert className="research-error">
											The completed report could not be displayed safely.
										</TerminalAlert>
									)}
								</section>
							)
							: null}
						{error !== undefined && (
							<TerminalAlert className="research-refresh-error">
								<p>
									The latest research state could not be loaded. The last saved result remains
									visible.
								</p>
								<button
									className="btn btn-sm btn-secondary"
									onClick={() => void refresh()}
									type="button"
								>
									Try again
								</button>
							</TerminalAlert>
						)}
					</section>
					{report && (
						<ResearchThread
							agent={agent}
							backgroundJobs={capabilities.backgroundJobs}
							canCancel={canCancel}
							canEdit={workspaceCanEdit}
							connected={connected}
							detail={detail}
							onCancel={turnId => void cancel(turnId)}
							onSaved={acceptMutation}
							webResearch={capabilities.webResearch}
						/>
					)}
				</main>
			</div>
			{cancellationError !== undefined && (
				<TerminalAlert className="research-cancel-error">
					{cancellationError instanceof Error
						? cancellationError.message
						: "Could not cancel the active research turn."}
				</TerminalAlert>
			)}
			<p className="sr-only" aria-live="polite">
				{refreshing ? "Refreshing research" : `${connection}. ${workspaceStatus}.`}
			</p>
		</div>
	);
}
