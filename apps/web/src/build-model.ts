import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

type Snapshot = ImplementationSnapshot;
type Progress = NonNullable<Snapshot["lifecycle"]["activity"]>;
export type TaskState = Progress["tasks"][number]["state"];

/** What the Build view shows: one status line, at most one action, then the tasks. */
export type BuildPhase =
	| { kind: "loading" }
	/** Tasks are missing, out of date or were returned; `draft` is the Planner request to send. */
	| { kind: "drafting"; draft: "prepare" | "revise" | "returned" }
	/** `stale` when there are no tasks for the current revision to show beneath the blockers. */
	| { kind: "blocked"; decisions: boolean; comments: boolean; stale: boolean }
	| { kind: "review" }
	| { kind: "building" }
	/** The build ended before it claimed the tasks; a retry is safe. */
	| { kind: "failed" }
	/** The build ended while its run still holds the tasks and the document lock. */
	| { kind: "stopped" }
	| { kind: "done"; pullRequests: number }
	/** A living document: its pull requests follow later edits. */
	| { kind: "live"; sync: SyncStatus };

/**
 * Whether a living document's pull requests match it. `out-of-sync` says why:
 * `pending` waits for the builder's connected agent to pick the edits up,
 * `waiting` for that agent to connect, and `failed` that the last rebuild failed.
 * `outstanding` counts tasks an earlier build left unfinished; only an edit retries
 * them, so a document otherwise in sync with any `needs-attention`.
 */
export type SyncStatus =
	| { kind: "building" }
	| { kind: "in-sync" }
	| { kind: "needs-attention"; outstanding: number }
	| { kind: "out-of-sync"; reason: "pending" | "waiting" | "failed"; outstanding: number };

const RUNNING = ["queued", "starting", "running"];

/**
 * The living document's sync status, or `undefined` before its first build has delivered.
 * The snapshot's `build` is the first build, or nothing once a rebuild adds a task version,
 * so a running rebuild is read from `live.rebuild`.
 */
export function syncStatus(snapshot: Snapshot | undefined): SyncStatus | undefined {
	let live = snapshot?.live;
	if (!snapshot || !live) return;
	if (
		live.rebuild && RUNNING.includes(live.rebuild.state)
		|| snapshot.build && RUNNING.includes(snapshot.build.state)
		|| snapshot.lifecycle.execution.state === "active"
	) return { kind: "building" };
	let outstanding = live.outstandingTasks?.length ?? 0;
	if (!live.outOfSync) {
		return outstanding ? { kind: "needs-attention", outstanding } : { kind: "in-sync" };
	}
	if (live.rebuild?.state === "failed") {
		return { kind: "out-of-sync", reason: "failed", outstanding };
	}
	return {
		kind: "out-of-sync",
		reason: live.builderConnected ? "pending" : "waiting",
		outstanding,
	};
}

export const SYNC_LABEL: Record<SyncStatus["kind"], string> = {
	building: "Building…",
	"in-sync": "In sync",
	"needs-attention": "Needs attention",
	"out-of-sync": "Out of sync",
};

/** Why the pull requests lag the document, naming the builder whose agent must run them. */
export function syncHint(
	status: SyncStatus | undefined,
	snapshot: Snapshot | undefined,
	userId: string | undefined,
): string | undefined {
	if (status?.kind === "needs-attention") return attentionHint(snapshot);
	if (status?.kind !== "out-of-sync") return;
	let retry = status.outstanding
		? ` · will also retry ${plural(status.outstanding, "blocked task", "blocked tasks")}`
		: "";
	if (status.reason === "pending") return `Changes will build shortly${retry}`;
	if (status.reason === "failed") return `The last rebuild failed${retry}`;
	if (snapshot?.live?.user === userId) return `Waiting for your agent${retry}`;
	return snapshot?.builtBy
		? `Waiting for @${snapshot.builtBy}’s agent${retry}`
		: `Waiting for the builder’s agent${retry}`;
}

/** What an unfinished task is stuck on, and that an edit retries it. */
export function attentionHint(snapshot: Snapshot | undefined): string | undefined {
	let tasks = snapshot?.live?.outstandingTasks ?? [];
	if (!tasks.length) return;
	let first = tasks.find(task => task.blocker) ?? tasks[0]!;
	let reason = first.blocker
		? `“${first.title}” is blocked: ${first.blocker.trim().replace(/\.+$/, "")}`
		: `“${first.title}” didn’t finish`;
	let more = tasks.length > 1 ? ` (and ${plural(tasks.length - 1, "other", "others")})` : "";
	let said = `${reason}${more}`;
	return `${said}${/[?!…]$/.test(said) ? "" : "."} Edit the document to retry.`;
}

/** Why a first build has not started yet, when the viewer's agent is finishing a prototype. */
export function startingHint(snapshot: Snapshot | undefined): string | undefined {
	if (snapshot?.build?.state !== "queued") return;
	let other = snapshot.waitingForDocument;
	if (other) {
		return `Starts when your agent finishes ${
			other.title ? `“${other.title}”` : "another document"
		}`;
	}
	return snapshot.waitingForPrototype ? "Starts when the current prototype finishes" : undefined;
}

/**
 * The header slot while a first build is under way: `queued` while it waits for
 * the agent's prototype, so the wait reads without hovering for the hint.
 */
export function startingLabel(
	snapshot: Snapshot | undefined,
): { label: string; queued: boolean; hint?: string } {
	let hint = startingHint(snapshot);
	return hint ? { label: "Queued", queued: true, hint } : { label: "Building…", queued: false };
}

/** One pull request's living-document commits, newest first. */
export function pullRequestCommits(snapshot: Snapshot | undefined, url: string) {
	return (snapshot?.live?.commits ?? []).map((commit, index) => ({ commit, index }))
		.filter(item => item.commit.pullRequest === url)
		.sort((a, b) => Date.parse(b.commit.at) - Date.parse(a.commit.at) || b.index - a.index)
		.map(item => item.commit);
}

/** "just now", "5m ago", "3h ago" or "2d ago". */
export function ago(at: string, now: number): string | undefined {
	let start = Date.parse(at);
	if (!Number.isFinite(start)) return;
	let minutes = Math.max(0, Math.floor((now - start) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	let hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function latestRun(snapshot: Snapshot) {
	let graph = snapshot.graph;
	return snapshot.lifecycle.history.findLast(item =>
		item.run.graphVersion === graph?.number && item.run.graphRevision === graph?.revision
	);
}

/** The task progress to show: the live run, else the last finished run of these tasks. */
export function buildProgress(snapshot: Snapshot | undefined): Progress | undefined {
	if (!snapshot) return;
	return snapshot.lifecycle.activity ?? latestRun(snapshot)?.progress;
}

export function buildPhase(snapshot: Snapshot | undefined): BuildPhase {
	if (!snapshot) return { kind: "loading" };
	let sync = syncStatus(snapshot);
	if (sync) return { kind: "live", sync };
	let run = latestRun(snapshot);
	let active = snapshot.lifecycle.execution.state === "active";
	let build = snapshot.build;
	let ended = build?.state === "failed" || build?.state === "stopped";
	if (run?.outcome.kind === "implemented" || run?.outcome.kind === "delivered") {
		let urls = new Set(
			(buildProgress(snapshot)?.tasks ?? []).flatMap(task =>
				task.pullRequest ? [task.pullRequest.url] : []
			),
		);
		return { kind: "done", pullRequests: urls.size };
	}
	if (active) return ended ? { kind: "stopped" } : { kind: "building" };
	if (build && !ended) return { kind: "building" };
	if (snapshot.blockers.length > 0) {
		return {
			kind: "blocked",
			decisions: snapshot.blockers.includes("unanswered questionnaires"),
			comments: snapshot.blockers.includes("accepted comments awaiting plan changes"),
			stale: !snapshot.graph || snapshot.graph.planRevision !== snapshot.planRevision,
		};
	}
	let graph = snapshot.graph;
	if (!graph) return { kind: "drafting", draft: "prepare" };
	if (graph.planRevision !== snapshot.planRevision) return { kind: "drafting", draft: "revise" };
	if (run?.outcome.kind === "revision_requested") return { kind: "drafting", draft: "returned" };
	if (ended) return { kind: "failed" };
	return { kind: "review" };
}

/** One automatic Planner request per document, revision and reason in this page. */
export function draftKey(
	channel: string,
	planRevision: number,
	draft: "prepare" | "revise" | "returned",
): string {
	return `${channel}:${planRevision}:${draft}`;
}

export function pullRequestNumber(url: string): number | undefined {
	let match = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
	return match ? Number(match[1]) : undefined;
}

/** Whole minutes or hours and minutes, e.g. "38m" or "1h 5m". */
export function elapsed(since: string, now: number): string | undefined {
	let start = Date.parse(since);
	if (!Number.isFinite(start)) return;
	let minutes = Math.max(0, Math.floor((now - start) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	let hours = Math.floor(minutes / 60);
	let rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export const TASK_STATE_LABEL: Record<TaskState, string> = {
	queued: "queued",
	in_progress: "in progress",
	blocked: "blocked",
	completed: "done",
};

/** Active and blocked rows start open; so does a linked task. */
export function taskStartsOpen(state: TaskState, linked: boolean): boolean {
	return linked || state === "in_progress" || state === "blocked";
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** Who a build in progress is attributed to: the viewer, a login, or nobody known. */
export function startedBy(snapshot: Snapshot | undefined, userId: string): string | undefined {
	if (!snapshot?.build) return;
	if (snapshot.build.user === userId) return "you";
	return snapshot.startedBy;
}

/** A Planner request for tasks, from sending until its turn has ended. */
export type DraftRequest = {
	key: string;
	/** The server's id for the request, once it answers. */
	id?: string;
	state: "sending" | "queued" | "running" | "ended" | "failed";
	/** Chat was seen busy while this request was live. */
	busySeen?: boolean;
};

export function draftInFlight(request: DraftRequest | undefined): boolean {
	return request?.state === "sending" || request?.state === "queued"
		|| request?.state === "running";
}

export type DraftEvent =
	| { type: "reply"; id: string; state: "queued" | "running" | "ended" }
	| { type: "drafting"; id: string; state: "queued" | "running" | "ended" }
	| { type: "busy"; busy: boolean }
	| { type: "refused" };

/**
 * Follow one request through its own turn; `undefined` when nothing changes.
 *
 * Only events naming this request's id move it, so another turn ending never
 * reads as this one failing. Chat going idle is a fallback for an `ended`
 * broadcast missed across a reconnect: at once for a running request the
 * server has acknowledged, and for a queued one only after it was seen busy.
 */
export function advanceDraft(
	request: DraftRequest | undefined,
	event: DraftEvent,
): DraftRequest | undefined {
	if (!request) return;
	if (event.type === "refused") {
		return request.state === "sending" ? { ...request, state: "failed" } : undefined;
	}
	if (event.type === "reply") {
		if (request.state !== "sending") return;
		return { ...request, id: event.id, state: event.state };
	}
	if (event.type === "drafting") {
		if (!request.id || event.id !== request.id || !draftInFlight(request)) return;
		return event.state === request.state ? undefined : { ...request, state: event.state };
	}
	if (request.state !== "queued" && request.state !== "running") return;
	if (event.busy) return request.busySeen ? undefined : { ...request, busySeen: true };
	return request.busySeen || request.state === "running"
		? { ...request, state: "ended" }
		: undefined;
}

/**
 * Whether opening Build should ask for tasks now.
 *
 * Only the drafting need seen by the first read after entering Build counts, so
 * a collaborator's edit while the view stays open never starts another turn.
 */
export function shouldAutoDraft(input: {
	active: boolean;
	canDraft: boolean;
	chatLoaded: boolean;
	plannerBusy: boolean;
	connected: boolean;
	key: string | undefined;
	/** The key the first read of this activation needed, if it needed one. */
	eligible: string | undefined;
	autoSent: boolean;
	alreadyDrafted: boolean;
	request: DraftRequest | undefined;
}): boolean {
	return input.active && input.canDraft && input.chatLoaded && !input.plannerBusy
		&& input.connected && !!input.key && input.key === input.eligible && !input.autoSent
		&& !input.alreadyDrafted && !draftInFlight(input.request);
}

/**
 * Plain copy for a refusal the server explains, or `undefined` for one it does
 * not, which reads as Chopin failing to draft.
 */
export function draftRefusalCopy(message: string): string | undefined {
	if (/unanswered questionnaires/.test(message)) return "Answer the open decisions first.";
	if (/accepted comments/.test(message)) {
		return "Update the document for accepted comments first.";
	}
	if (/implementation is already active/.test(message)) return "A build is already running.";
	if (/queue is full|too many/.test(message)) {
		return "Chopin is busy with other requests. Try again shortly.";
	}
	if (/Planner is not running/.test(message)) return "Chopin isn’t running for this document.";
	if (/write access|authorization expired/.test(message)) {
		return "You need write access to this repository to build.";
	}
	if (/cannot be built/.test(message)) return "This document can’t be built.";
}

/** Whether this document has ever been handed to a coding agent. */
export function hasBuilt(snapshot: Snapshot): boolean {
	return !!snapshot.build || snapshot.lifecycle.execution.state === "active"
		|| snapshot.lifecycle.history.length > 0;
}

/**
 * The header's one-click first build: draft the tasks, then start them, with
 * no review in between. `failed` keeps the button so a person can try again;
 * `agent` says the last start found no local agent to run it.
 */
export type FirstBuild =
	| { stage: "idle" }
	| { stage: "drafting"; sent: boolean }
	/** The draft raised a blocker, or a reload found the request: continue once it clears. */
	| { stage: "waiting" }
	| { stage: "starting" }
	| { stage: "started" }
	| { stage: "failed"; agent?: boolean; message?: string };

export type FirstBuildEvent =
	| { type: "press" }
	/** The server still holds this viewer's one-click request, e.g. after a reload. */
	| { type: "resume" }
	/** The draft left the document blocked; keep the intent until the blockers clear. */
	| { type: "wait" }
	| { type: "draft-sent" }
	/** The draft turn ended; `drafted` when a fresh read then had tasks to start. */
	| { type: "draft-ended"; drafted: boolean }
	| { type: "draft-refused"; message?: string }
	| { type: "start" }
	| { type: "started" }
	| { type: "start-refused"; agent: boolean; message?: string }
	| { type: "reset" };

export function advanceFirstBuild(state: FirstBuild, event: FirstBuildEvent): FirstBuild {
	switch (event.type) {
		case "press":
			return state.stage === "idle" || state.stage === "failed"
				? { stage: "drafting", sent: false }
				: state;
		case "resume":
			return state.stage === "idle" ? { stage: "waiting" } : state;
		case "wait":
			return state.stage === "drafting" ? { stage: "waiting" } : state;
		case "draft-sent":
			return state.stage === "drafting" || state.stage === "waiting"
				? { stage: "drafting", sent: true }
				: state;
		case "draft-ended":
			return state.stage === "drafting" && state.sent && !event.drafted
				? { stage: "failed", message: "Chopin couldn’t break the plan into tasks." }
				: state;
		case "draft-refused":
			return state.stage === "drafting" ? { stage: "failed", message: event.message } : state;
		case "start":
			return state.stage === "drafting" || state.stage === "waiting" || state.stage === "failed"
				? { stage: "starting" }
				: state;
		case "started":
			return state.stage === "starting" ? { stage: "started" } : state;
		case "start-refused":
			return state.stage === "starting"
				? { stage: "failed", agent: event.agent, message: event.message }
				: state;
		case "reset":
			return { stage: "idle" };
	}
}

/**
 * What the header shows for a snapshot and the first build's stage, and the
 * one step the browser should take next, if any.
 *
 * The button appears only for a document judged ready that has never been
 * built. Once pressed it reads as working until the build runs or the attempt
 * ends; `reset` hands any later state back to the Build view. A draft that
 * raises a decision does not drop the press: the slot reads `waiting` until the
 * blockers clear, then drafts again if the tasks are stale and starts them. The
 * server keeps the press (`buildRequested`), so a reload `resume`s it.
 */
export function firstBuildStep(
	snapshot: Snapshot | undefined,
	state: FirstBuild,
	userId?: string,
): {
	view: "hidden" | "ready" | "working" | "waiting";
	next?: "draft" | "start" | "reset" | "resume" | "wait";
} {
	if (!snapshot) return { view: state.stage === "idle" ? "hidden" : "working" };
	let phase = buildPhase(snapshot);
	if (phase.kind === "building") {
		return { view: "working", ...(state.stage === "idle" ? {} : { next: "reset" as const }) };
	}
	let requested = !!userId && snapshot.buildRequested?.by === userId && !hasBuilt(snapshot);
	let pending = phase.kind === "blocked" || phase.kind === "drafting" || phase.kind === "review";
	if (state.stage === "idle" && requested && pending) {
		return { view: phase.kind === "blocked" ? "waiting" : "working", next: "resume" };
	}
	if (state.stage === "idle" || state.stage === "failed") {
		let open = phase.kind === "drafting" || phase.kind === "review";
		return { view: snapshot.buildReady && open && !hasBuilt(snapshot) ? "ready" : "hidden" };
	}
	if (state.stage === "starting") return { view: "working" };
	if (state.stage === "started") {
		return phase.kind === "review" ? { view: "working" } : { view: "hidden", next: "reset" };
	}
	if (state.stage === "waiting") {
		// Cancelled, or someone else built it: nothing is left to continue.
		if (!requested) return { view: "hidden", next: "reset" };
		if (phase.kind === "blocked") return { view: "waiting" };
		if (phase.kind === "drafting") return { view: "working", next: "draft" };
		if (phase.kind === "review") return { view: "working", next: "start" };
		return { view: "hidden", next: "reset" };
	}
	if (phase.kind === "review") return { view: "working", next: "start" };
	if (phase.kind === "drafting") {
		return { view: "working", ...(state.sent ? {} : { next: "draft" }) };
	}
	if (phase.kind === "blocked") return { view: "waiting", next: "wait" };
	return { view: "hidden", next: "reset" };
}

/** The header's wait for a blocked one-click build, and where pressing it leads. */
export function waitingLabel(
	snapshot: Snapshot | undefined,
): { label: string; target: "decisions" | "build" } {
	let phase = snapshot && buildPhase(snapshot);
	if (phase?.kind === "blocked" && phase.decisions) {
		return { label: "Waiting on a decision", target: "decisions" };
	}
	if (phase?.kind === "blocked" && phase.comments) {
		return { label: "Waiting on comments", target: "build" };
	}
	return { label: "Waiting to build", target: "build" };
}
