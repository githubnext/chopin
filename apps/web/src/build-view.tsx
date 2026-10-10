import { useEffect, useId, useRef, useState } from "react";

import {
	advanceDraft,
	ago,
	buildPhase,
	buildProgress,
	draftInFlight,
	draftKey,
	draftRefusalCopy,
	elapsed,
	plural,
	pullRequestCommits,
	pullRequestNumber,
	shouldAutoDraft,
	startedBy,
	SYNC_LABEL,
	syncHint,
	TASK_STATE_LABEL,
	taskStartsOpen,
} from "./build-model";
import {
	implementationEndpoint,
	implementationResponse as response,
	startBuild,
} from "./build-start";

import type { Implementation, ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { ReactNode } from "react";
import type { DraftEvent, DraftRequest, TaskState } from "./build-model";
import type { Wire } from "./wire";

/** Automatic Planner requests already sent from this page, by `draftKey`. */
const drafted = new Set<string>();
/** The latest Planner request for tasks, by document; it outlives leaving Build. */
const requests = new Map<string, DraftRequest>();
/** How long a request may wait for the server's answer before it counts as failed. */
const ANSWER_WINDOW_MS = 10_000;

function sentence(text: string): string {
	return text.replace(/^[a-z]/, letter => letter.toUpperCase());
}

export function BuildView(
	{
		active,
		canEdit,
		chatLoaded,
		comments,
		needsAgentSignal = 0,
		onShowDecisions,
		onShowDocument,
		planner,
		plannerBusy,
		room,
		unanswered,
		userId,
		wire,
	}: {
		active: boolean;
		canEdit: boolean;
		/** The Chat transcript has arrived, so `plannerBusy` is the room's real state. */
		chatLoaded: boolean;
		/** Accepted comments the document has not yet taken in. */
		comments: number;
		/** Increments when the header's Build plan found no local agent, to show how to start one. */
		needsAgentSignal?: number;
		onShowDecisions: () => void;
		onShowDocument: () => void;
		planner: boolean;
		plannerBusy: boolean;
		room: string;
		unanswered: number;
		userId: string;
		wire?: Wire;
	},
) {
	let [snapshot, setSnapshot] = useState<ImplementationSnapshot>();
	let [loadError, setLoadError] = useState<string>();
	let [actionError, setActionError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let [refresh, setRefresh] = useState(0);
	let [needsAgent, setNeedsAgent] = useState(false);
	let [returning, setReturning] = useState(false);
	let [reason, setReason] = useState("");
	let [open, setOpen] = useState<Record<string, boolean>>({});
	let [linked, setLinked] = useState<string>();
	let [now, setNow] = useState(() => Date.now());
	let [request, setRequestState] = useState(() => requests.get(room));
	let setRequest = (next: DraftRequest | undefined) => {
		if (next) requests.set(room, next);
		else requests.delete(room);
		setRequestState(next);
	};
	let advance = (event: DraftEvent) => {
		let next = advanceDraft(requests.get(room), event);
		if (!next) return;
		setRequest(next);
		if (next.state === "ended") setRefresh(value => value + 1);
	};
	/**
	 * One entry into Build. Only its first read decides whether to draft, and it
	 * drafts at most once, so edits made while the view stays open never do.
	 */
	let activation = useRef({ id: 0, decided: false, eligible: undefined as string | undefined });
	let [autoSent, setAutoSent] = useState(0);
	let endpoint = implementationEndpoint(room);
	let phase = buildPhase(snapshot);
	let progress = buildProgress(snapshot);
	let draft = phase.kind === "drafting" ? phase.draft : undefined;
	let key = snapshot && draft ? draftKey(room, snapshot.planRevision, draft) : undefined;
	let canDraft = canEdit && planner;

	useEffect(() => {
		if (!active) return;
		activation.current = { id: activation.current.id + 1, decided: false, eligible: undefined };
	}, [active]);

	useEffect(() => {
		if (!active) return;
		let controller = new AbortController();
		let entered = activation.current.id;
		void (async () => {
			try {
				let value = await response<ImplementationSnapshot>(
					await fetch(endpoint, { signal: controller.signal, cache: "no-store" }),
				);
				if (controller.signal.aborted) return;
				setSnapshot(current => !current || value.revision >= current.revision ? value : current);
				setLoadError(undefined);
				let next = buildPhase(value);
				let nextKey = next.kind === "drafting"
					? draftKey(room, value.planRevision, next.draft)
					: undefined;
				let current = activation.current;
				if (current.id === entered && !current.decided) {
					current.decided = true;
					current.eligible = nextKey;
				}
				// A turn that ended and left nothing to review failed, as far as Build can tell.
				let latest = requests.get(room);
				if (latest?.state === "ended") {
					setRequest(nextKey === latest.key ? { ...latest, state: "failed" } : undefined);
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				setLoadError(error instanceof Error ? error.message : "Connection failed");
			}
		})();
		return () => controller.abort();
	}, [active, endpoint, refresh]);

	useEffect(() => {
		if (!active) return;
		let reload = () => setRefresh(value => value + 1);
		let off = ["plan:implementation", "plan:open", "plan:update", "experiment:changed"]
			.map(kind => wire?.on(kind, reload));
		return () => off.forEach(remove => remove?.());
	}, [active, wire]);

	// The server answers with the document's live request, which may be a collaborator's.
	let sendDraft = async () => {
		if (!snapshot || !key || !wire?.connected || draftInFlight(request)) return;
		setRequest({ key, state: "sending" });
		setActionError(undefined);
		try {
			let answer = await wire.ask<Implementation.Drafted>("implementation:draft", {
				requestId: crypto.randomUUID(),
				planRevision: snapshot.planRevision,
			});
			advance({ type: "reply", id: answer.id, state: answer.state });
		} catch (error) {
			// A refusal the server explains is shown as such; anything else reads as a failed draft.
			let copy = error instanceof Error ? draftRefusalCopy(error.message) : undefined;
			if (!copy) {
				advance({ type: "refused" });
				return;
			}
			if (requests.get(room)?.state === "sending") setRequest(undefined);
			setActionError(copy);
			setRefresh(value => value + 1);
		}
	};

	useEffect(
		() =>
			wire?.on<Implementation.Drafting>(
				"implementation:drafting",
				frame => advance({ type: "drafting", id: frame.id, state: frame.state }),
			),
		[wire, room],
	);

	// Opening Build drafts the tasks, once, and never while the Planner is in a turn.
	useEffect(() => {
		let ready = shouldAutoDraft({
			active,
			canDraft,
			chatLoaded,
			plannerBusy,
			connected: !!wire?.connected,
			key,
			eligible: activation.current.eligible,
			autoSent: autoSent === activation.current.id,
			alreadyDrafted: !!key && drafted.has(key),
			request,
		});
		if (!ready || !key) return;
		drafted.add(key);
		setAutoSent(activation.current.id);
		void sendDraft();
	});

	useEffect(() => advance({ type: "busy", busy: plannerBusy }), [plannerBusy, request?.state]);

	// A request the server never answers stops holding the way for another.
	useEffect(() => {
		if (request?.state !== "sending") return;
		let timer = window.setTimeout(() => advance({ type: "refused" }), ANSWER_WINDOW_MS);
		return () => window.clearTimeout(timer);
	}, [request?.state, request?.key]);

	let pending = phase.kind === "building" || phase.kind === "live";
	useEffect(() => {
		if (!pending || !active) return;
		setNow(Date.now());
		let timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [pending, active]);

	// The local-agent note answers one press of one button; a new phase clears it.
	useEffect(() => setNeedsAgent(false), [phase.kind]);
	useEffect(() => {
		if (needsAgentSignal > 0) setNeedsAgent(true);
	}, [needsAgentSignal]);

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

	let start = async () => {
		if (!snapshot?.graph || busy) return;
		setActionError(undefined);
		setNeedsAgent(false);
		setBusy(true);
		try {
			if (await startBuild(room, snapshot) === "needs-agent") setNeedsAgent(true);
			else setRefresh(value => value + 1);
		} catch (error) {
			setActionError(sentence(error instanceof Error ? error.message : "Build failed"));
		} finally {
			setBusy(false);
		}
	};

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
			setRefresh(value => value + 1);
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
	// Drafting: our turn is under way, or Build is about to ask, or it failed, or a person decides.
	let awaitingAuto = !!key && key === activation.current.eligible
		&& autoSent !== activation.current.id && !drafted.has(key);
	let drafting = draft && canDraft
		? draftInFlight(request) || request?.state === "ended" || awaitingAuto
			? "working"
			: request?.key === key && request?.state === "failed"
			? "failed"
			: "manual"
		: undefined;
	let staleTasks = phase.kind === "drafting" && tasks.length > 0;
	let showTasks = tasks.length > 0 && phase.kind !== "loading"
		&& !(phase.kind === "blocked" && phase.stale)
		&& !(phase.kind === "drafting" && !staleTasks);
	let primaryLabel = phase.kind === "failed" ? "Try again" : "Build on my laptop";
	let primary = (
		<button
			aria-busy={busy || undefined}
			className="btn btn-md btn-primary shrink-0"
			disabled={busy}
			onClick={() => void start()}
			type="button"
		>
			{busy ? "Starting…" : primaryLabel}
		</button>
	);
	let manual = (label: string) => (
		<button
			className="btn btn-md btn-outline shrink-0"
			disabled={draftInFlight(request) || !wire?.connected}
			onClick={() => void sendDraft()}
			type="button"
		>
			{label}
		</button>
	);

	let status: ReactNode;
	let action: ReactNode;
	let since: string | undefined;
	if (phase.kind === "loading") {
		status = loadError
			? <span className="text-destructive-ink">{sentence(loadError)}</span>
			: <span className="sr-only">Loading tasks</span>;
	} else if (phase.kind === "drafting") {
		if (!drafting) {
			status = "No tasks yet.";
		} else if (drafting === "working") {
			status = (
				<>
					<span aria-hidden="true" className="build-pulse" />
					Breaking the plan into tasks…
				</>
			);
		} else if (drafting === "failed") {
			status = "Chopin couldn’t break the plan into tasks.";
			action = manual("Try again");
		} else if (phase.draft === "revise") {
			status = "The document changed since these tasks were drafted.";
			action = manual("Update tasks");
		} else if (phase.draft === "returned") {
			status = "The build was returned for changes.";
			action = manual("Update tasks");
		} else {
			status = "No tasks yet.";
			action = manual("Break into tasks");
		}
	} else if (phase.kind === "blocked") {
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
	} else if (phase.kind === "review") {
		status = plural(tasks.length, "task", "tasks");
		if (canEdit) action = primary;
	} else if (phase.kind === "building") {
		since = snapshot?.build && elapsed(snapshot.build.createdAt, now);
		let who = startedBy(snapshot, userId);
		status = (
			<>
				<span aria-hidden="true" className="build-pulse" />
				<span className="min-w-0 flex-1">
					Building{who ? ` · started by ${who === "you" ? who : `@${who}`}` : ""}
				</span>
			</>
		);
	} else if (phase.kind === "failed") {
		status = "The build stopped before it started.";
		if (canEdit) action = primary;
	} else if (phase.kind === "stopped") {
		status = "The build stopped.";
		if (canEdit && !returning) {
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
	} else if (phase.kind === "live") {
		let commits = snapshot?.live?.commits.length ?? 0;
		let hint = syncHint(phase.sync, snapshot, userId);
		status = (
			<>
				{phase.sync.kind === "building" && <span aria-hidden="true" className="build-pulse" />}
				<span className="min-w-0 flex-1">
					Living document ·{" "}
					{phase.sync.kind === "building" ? "Building" : SYNC_LABEL[phase.sync.kind]}
					{phase.sync.kind === "in-sync"
						&& ` · ${plural(commits, "commit", "commits")} since first build`}
					{hint && <span className="text-text-tertiary">{` · ${hint}`}</span>}
				</span>
			</>
		);
	} else {
		status = `Built · ${plural(phase.pullRequests, "pull request", "pull requests")}`;
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
				{(needsAgent || snapshot?.localAgent === false)
					&& (phase.kind === "review" || phase.kind === "failed") && (
					<div className="build-note">
						<p className="m-0">Start your local agent to build:</p>
						<code className="build-command">
							{`CHOPIN_URL=${location.origin} bun run connector connect /path/to/project -- copilot --acp`}
						</code>
						<p className="m-0">Open the link it prints, then press {primaryLabel}.</p>
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
				{(phase.kind === "loading" && !loadError
					|| drafting === "working" && !staleTasks) && (
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
				{phase.kind === "review" && canEdit && planner && (
					<p className="build-hint">To change tasks, ask Chopin in Chat.</p>
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
