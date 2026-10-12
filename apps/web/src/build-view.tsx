import { useEffect, useId, useState } from "react";

import { BuildGlyph } from "./build-plan-button";
import {
	ago,
	buildLabel,
	buildPhase,
	buildProgress,
	elapsed,
	plural,
	pullRequestCommits,
	pullRequestNumber,
	startedBy,
	TASK_STATE_LABEL,
	taskStartsOpen,
} from "./build-model";
import {
	cancelBuildRequest,
	implementationEndpoint,
	implementationResponse as response,
} from "./build-start";

import type { ReactNode } from "react";
import type { BuildPlan } from "./build-plan-button";
import type { TaskState } from "./build-model";

function sentence(text: string): string {
	return text.replace(/^[a-z]/, letter => letter.toUpperCase());
}

/**
 * The build's status and its tasks. Build only reads: the header's Build plan
 * and capsule start and retry builds, so opening this view never starts one.
 * It keeps the recoveries that need its context, such as Return to planning.
 */
export function BuildView(
	{
		active,
		build,
		canEdit,
		comments,
		onShowDecisions,
		onShowDocument,
		room,
		unanswered,
		userId,
	}: {
		active: boolean;
		build: BuildPlan;
		canEdit: boolean;
		/** Accepted comments the document has not yet taken in. */
		comments: number;
		onShowDecisions: () => void;
		onShowDocument: () => void;
		room: string;
		unanswered: number;
		userId: string;
	},
) {
	let { look, snapshot, loadError } = build;
	let [actionError, setActionError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let [returning, setReturning] = useState(false);
	let [reason, setReason] = useState("");
	let [open, setOpen] = useState<Record<string, boolean>>({});
	let [linked, setLinked] = useState<string>();
	let [now, setNow] = useState(() => Date.now());
	let endpoint = implementationEndpoint(room);
	let phase = buildPhase(snapshot);
	let progress = buildProgress(snapshot);

	let pending = phase.kind === "building" || phase.kind === "live";
	useEffect(() => {
		if (!pending || !active) return;
		setNow(Date.now());
		let timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [pending, active]);

	useEffect(() => {
		let follow = () => {
			if (!location.hash.startsWith("#task-")) return;
			let id = location.hash.slice("#task-".length);
			setLinked(id);
			setOpen(current => ({ ...current, [id]: true }));
		};
		follow();
		addEventListener("hashchange", follow);
		return () => removeEventListener("hashchange", follow);
	}, []);

	let graphNumber = snapshot?.graph?.number;
	useEffect(() => {
		if (!active || !linked || graphNumber === undefined) return;
		requestAnimationFrame(() => {
			document.getElementById(`task-${linked}`)?.scrollIntoView({ block: "nearest" });
		});
	}, [active, linked, graphNumber]);

	let returnToPlanning = async () => {
		if (!snapshot?.build || busy) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await response(
				await fetch(`${endpoint}/revise`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ buildId: snapshot.build.id, reason }),
				}),
			);
			setReason("");
			setReturning(false);
			build.reload();
		} catch (error) {
			setActionError(sentence(error instanceof Error ? error.message : "Return failed"));
		} finally {
			setBusy(false);
		}
	};

	// A living document lists its first build's tasks and every rebuild's after them.
	let tasks = phase.kind === "live"
		? snapshot?.live?.tasks ?? []
		: snapshot?.graph?.definition.tasks ?? [];
	let staleTasks = phase.kind === "drafting" && tasks.length > 0;
	let breaking = look.kind === "tasks" && phase.kind !== "review";
	let showTasks = tasks.length > 0 && phase.kind !== "loading" && !breaking
		&& !(phase.kind === "blocked" && phase.stale)
		&& !(phase.kind === "drafting" && !staleTasks);

	let status: ReactNode;
	let action: ReactNode;
	let since: string | undefined;
	if (phase.kind === "loading") {
		status = loadError
			? <span className="text-destructive-ink">{sentence(loadError)}</span>
			: <span className="sr-only">Loading tasks</span>;
	} else if (look.kind === "plan") {
		// Built before, now back in planning: Build plan in the header builds it again.
		if (phase.kind === "blocked") {
			status = phase.decisions || phase.comments
				? (
					<span className="build-blockers">
						{phase.decisions && (
							<button className="build-link" onClick={onShowDecisions} type="button">
								{unanswered > 0
									? `Answer ${plural(unanswered, "decision", "decisions")} first`
									: "Answer the open decisions first"}
							</button>
						)}
						{phase.comments && (
							<button className="build-link" onClick={onShowDocument} type="button">
								{comments > 0
									? `Update the document for ${
										plural(comments, "accepted comment", "accepted comments")
									} first`
									: "Update the document for accepted comments first"}
							</button>
						)}
					</span>
				)
				: "This document can’t be built yet.";
		} else if (phase.kind === "drafting" && phase.draft === "returned") {
			status = "Returned for changes. Build plan builds it again.";
		} else if (phase.kind === "review") {
			status = plural(tasks.length, "task", "tasks");
		} else {
			status = "Not built yet.";
		}
	} else {
		let label = buildLabel(look);
		let detail: string | undefined;
		if (look.kind === "tasks") {
			label = "Breaking the document into tasks…";
			detail = look.tip === "Breaking the document into tasks" ? undefined : look.tip;
		} else if (look.kind === "building") {
			since = snapshot?.build && elapsed(snapshot.build.createdAt, now);
			let who = startedBy(snapshot, userId);
			detail = snapshot?.waitingForDocument || snapshot?.waitingForPrototype
				? look.tip
				: who && `started by ${who === "you" ? who : `@${who}`}`;
		} else if (look.kind === "built") {
			label = `Built · ${plural(look.pullRequests, "pull request", "pull requests")}`;
		} else {
			detail = look.tip;
		}
		status = (
			<>
				<BuildGlyph look={look} />
				<span className="min-w-0 flex-1">
					{label}
					{detail && <span className="text-text-tertiary">{` · ${detail}`}</span>}
				</span>
			</>
		);
	}
	if (phase.kind === "stopped" && canEdit && !returning) {
		action = (
			<button
				className="btn btn-md btn-outline shrink-0"
				onClick={() => setReturning(true)}
				type="button"
			>
				Return to planning
			</button>
		);
	}
	// A one-click Build plan waiting on a blocker can be given up here.
	if (phase.kind === "blocked" && canEdit && userId && snapshot?.buildRequested?.by === userId) {
		action = (
			<button
				className="btn btn-md btn-outline shrink-0"
				onClick={() => {
					setActionError(undefined);
					cancelBuildRequest(room).then(
						() => build.reload(),
						error =>
							setActionError(sentence(error instanceof Error ? error.message : "Cancel failed")),
					);
				}}
				type="button"
			>
				Cancel build
			</button>
		);
	}
	// A pull request shared by several tasks lists its commits under the first of them.
	let listed = new Set<string>();

	return (
		<div className="build-view">
			<div className="build-view-content" data-build-view-scroll="">
				<div className="build-status">
					<p
						aria-live={phase.kind === "blocked" ? undefined : "polite"}
						className="build-status-line"
					>
						{status}
					</p>
					{/* Outside the live region, so a ticking clock is not announced. */}
					{since && <span className="build-elapsed">{since}</span>}
					{action}
				</div>
				{(build.needsAgent || snapshot?.localAgent === false && look.kind === "stopped") && (
					<div className="build-note">
						<p className="m-0">Start your local agent to build:</p>
						<code className="build-command">
							{`CHOPIN_URL=${location.origin} bun run connector connect /path/to/project -- copilot --acp`}
						</code>
						<p className="m-0">Open the link it prints, then press Retry.</p>
					</div>
				)}
				{phase.kind === "stopped" && returning && (
					<form
						className="build-return"
						onSubmit={event => {
							event.preventDefault();
							void returnToPlanning();
						}}
					>
						<label className="flex flex-col gap-1 text-sm">
							What needs to change?
							<textarea
								autoFocus
								className="field w-full"
								maxLength={2000}
								onChange={event => setReason(event.target.value)}
								required
								rows={3}
								value={reason}
							/>
						</label>
						<div className="flex gap-2">
							<button
								className="btn btn-md btn-primary"
								disabled={busy || !reason.trim()}
								type="submit"
							>
								Return to planning
							</button>
							<button
								className="btn btn-md btn-ghost"
								onClick={() => setReturning(false)}
								type="button"
							>
								Cancel
							</button>
						</div>
					</form>
				)}
				{actionError && (
					<p className="m-0 mt-2 text-sm text-destructive-ink" role="alert">{actionError}</p>
				)}
				{(phase.kind === "loading" && !loadError || breaking && !staleTasks) && (
					<div aria-hidden="true" className="build-skeleton">
						{[0, 1, 2, 3, 4].map(index => <span key={index} />)}
					</div>
				)}
				{showTasks && (
					<ol aria-label="Tasks" className="build-tasks" data-stale={staleTasks || undefined}>
						{tasks.map(task => {
							let report = phase.kind === "live"
								? snapshot?.live?.tasks.find(item =>
									item.id === task.id
								)?.progress
								: progress?.tasks.find(item =>
									item.id === task.id
								);
							let url = report?.pullRequest?.url;
							let commits = url && !listed.has(url) ? pullRequestCommits(snapshot, url) : [];
							if (url) listed.add(url);
							let state: TaskState = report?.state ?? "queued";
							let expanded = open[task.id] ?? taskStartsOpen(state, linked === task.id);
							let after = task.dependsOn.map(id => tasks.find(item => item.id === id)?.title ?? id);
							let number = report?.pullRequest && pullRequestNumber(report.pullRequest.url);
							return (
								<li className="build-task" id={`task-${task.id}`} key={task.id}>
									<TaskRow
										after={after}
										expanded={expanded}
										onToggle={() => setOpen(current => ({ ...current, [task.id]: !expanded }))}
										pullRequest={report?.pullRequest && {
											...report.pullRequest,
											number,
										}}
										blocker={report?.blocker}
										commits={commits}
										now={now}
										state={state}
										task={task}
									/>
								</li>
							);
						})}
					</ol>
				)}
			</div>
		</div>
	);
}

function TaskRow(
	{ after, blocker, commits, expanded, now, onToggle, pullRequest, state, task }: {
		after: string[];
		blocker?: string;
		commits: Array<{ sha: string; message: string; at: string }>;
		expanded: boolean;
		now: number;
		onToggle: () => void;
		pullRequest?: { url: string; state: "open" | "merged" | "closed"; number?: number };
		state: TaskState;
		task: { id: string; title: string; goal: string; acceptance: string[] };
	},
) {
	let panel = useId();
	return (
		<>
			<div className="build-task-head">
				<button
					aria-controls={panel}
					aria-expanded={expanded}
					className="build-task-toggle"
					onClick={onToggle}
					type="button"
				>
					<span aria-hidden="true" className="build-task-dot" data-state={state} />
					<span className="build-task-title">{task.title}</span>
					<span className="sr-only">, {TASK_STATE_LABEL[state]}</span>
				</button>
				{pullRequest && (
					<a
						aria-label={pullRequest.number
							? `Pull request #${pullRequest.number}, ${pullRequest.state}`
							: `Pull request, ${pullRequest.state}`}
						className="build-task-pr"
						data-state={pullRequest.state}
						href={pullRequest.url}
						rel="noreferrer"
						target="_blank"
					>
						{pullRequest.number ? `#${pullRequest.number}` : "PR"}
					</a>
				)}
			</div>
			<div className="build-task-fold" data-open={expanded || undefined} id={panel}>
				<div inert={!expanded}>
					<div className="build-task-detail">
						<p className="m-0">{task.goal}</p>
						{task.acceptance.length > 0 && (
							<ul className="build-task-acceptance">
								{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}
							</ul>
						)}
						{after.length > 0 && <p className="m-0 text-text-tertiary">After {after.join(", ")}</p>}
						{blocker && <p className="build-task-blocker">Blocked: {blocker}</p>}
						{pullRequest && commits.length > 0 && (
							<ul aria-label="Commits" className="build-task-commits">
								{commits.map(commit => (
									<li key={commit.sha}>
										<a
											className="build-task-sha"
											href={`${pullRequest.url}/commits/${commit.sha}`}
											rel="noreferrer"
											target="_blank"
										>
											{commit.sha.slice(0, 7)}
										</a>
										<span className="min-w-0 flex-1 truncate">{commit.message}</span>
										<span className="build-elapsed">{ago(commit.at, now)}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		</>
	);
}
