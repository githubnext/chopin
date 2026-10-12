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

const RUNNING = new Set(["queued", "starting", "running"]);

/**
 * The living document's sync status, or `undefined` before its first build has delivered.
 * The snapshot's `build` is the first build, or nothing once a rebuild adds a task version,
 * so a running rebuild is read from `live.rebuild`.
 */
export function syncStatus(snapshot: Snapshot | undefined): SyncStatus | undefined {
	let live = snapshot?.live;
	if (!snapshot || !live) return;
	if (
		live.rebuild && RUNNING.has(live.rebuild.state)
		|| snapshot.build && RUNNING.has(snapshot.build.state)
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

/**
 * Plain copy for a refusal the server explains, or `undefined` for one it does
 * not, which reads as Chopin failing to draft.
 */
export function draftRefusalCopy(message: string, code?: string): string | undefined {
	if (code === "planner-not-attached" || /No Planner is attached/.test(message)) {
		return "Connect a Planner to this document to build.";
	}
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

/**
 * Plain copy for a refused build start or rebuild. The server answers with terse
 * internal reasons; a person sees what happened and what to do. Anything unknown
 * reads as a generic failure rather than the raw reason.
 */
export function buildRefusalCopy(message: string): string {
	let draft = draftRefusalCopy(message);
	if (draft) return draft.replace(/\.$/, "");
	if (/^no-workspace$/.test(message)) return "Start your local agent, then retry";
	if (/offline or busy/.test(message)) return "Your local agent is offline or busy with other work";
	if (/busy/i.test(message)) return "Your local agent is busy with another document";
	if (/reviewed graph has changed|reviewed build has changed|stale/.test(message)) {
		return "The tasks changed. Try again";
	}
	if (/review the existing build/.test(message)) {
		return "The last build needs attention in Build first";
	}
	if (/build history is full/.test(message)) return "This document has built too many times";
	if (/archived/.test(message)) return "This document is archived";
	if (/origin is not allowed|authentication required/.test(message)) {
		return "Sign in again to build";
	}
	if (/not found/.test(message)) return "This document is no longer available";
	if (/no tasks/i.test(message)) return "There are no tasks to build yet";
	return "The build couldn’t start. Try again";
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
	/** `redrafted` once an edit during the first draft made it stale and it was asked again. */
	| { stage: "drafting"; sent: boolean; redrafted?: boolean }
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
	/**
	 * The draft turn ended; `drafted` when a fresh read then had tasks to start, `changed` when
	 * it had tasks for an older revision because the document was edited while they were drafted.
	 */
	| { type: "draft-ended"; drafted: boolean; changed?: boolean }
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
				? {
					stage: "drafting",
					sent: true,
					...(state.stage === "drafting" && state.redrafted ? { redrafted: true } : {}),
				}
				: state;
		case "draft-ended":
			if (state.stage !== "drafting" || !state.sent || event.drafted) return state;
			// Edits made while the tasks were drafted left them stale: draft once more, then say so.
			if (event.changed && !state.redrafted) {
				return { stage: "drafting", sent: false, redrafted: true };
			}
			return {
				stage: "failed",
				message: event.changed
					? "The document changed while Chopin was breaking it into tasks."
					: "Chopin couldn’t break the plan into tasks.",
			};
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
 * Whether Build plan's press is still under way, and the one step the browser
 * should take next, if any.
 *
 * Once pressed it reads as `working` until the build runs or the attempt ends;
 * `reset` hands any later state back to the snapshot. A draft that raises a
 * decision does not drop the press: it reads `waiting` until the blockers
 * clear, then drafts again if the tasks are stale and starts them. The server
 * keeps the press (`buildRequested`), so a reload `resume`s it. A build that
 * failed before it claimed its tasks starts again from the same tasks.
 */
export function firstBuildStep(
	snapshot: Snapshot | undefined,
	state: FirstBuild,
	userId?: string,
): {
	view: "idle" | "working" | "waiting";
	next?: "draft" | "start" | "reset" | "resume" | "wait";
} {
	if (!snapshot) {
		return { view: state.stage === "idle" || state.stage === "failed" ? "idle" : "working" };
	}
	let phase = buildPhase(snapshot);
	if (phase.kind === "building") {
		return { view: "working", ...(state.stage === "idle" ? {} : { next: "reset" as const }) };
	}
	let requested = !!userId && snapshot.buildRequested?.by === userId && !hasBuilt(snapshot);
	let pending = phase.kind === "blocked" || phase.kind === "drafting" || phase.kind === "review";
	if (state.stage === "idle" && requested && pending) {
		return { view: phase.kind === "blocked" ? "waiting" : "working", next: "resume" };
	}
	if (state.stage === "idle" || state.stage === "failed") return { view: "idle" };
	if (state.stage === "starting") return { view: "working" };
	if (state.stage === "started") {
		return phase.kind === "review" ? { view: "working" } : { view: "idle", next: "reset" };
	}
	if (state.stage === "waiting") {
		// Cancelled, or someone else built it: nothing is left to continue.
		if (!requested) return { view: "idle", next: "reset" };
		if (phase.kind === "blocked") return { view: "waiting" };
		if (phase.kind === "drafting") return { view: "working", next: "draft" };
		if (phase.kind === "review") return { view: "working", next: "start" };
		return { view: "idle", next: "reset" };
	}
	if (phase.kind === "review" || phase.kind === "failed") return { view: "working", next: "start" };
	if (phase.kind === "drafting") {
		return { view: "working", ...(state.sent ? {} : { next: "draft" }) };
	}
	if (phase.kind === "blocked") return { view: "waiting", next: "wait" };
	return { view: "idle", next: "reset" };
}

/**
 * What the header's build slot, the Build tab's glyph and Build's headline show.
 *
 * `plan` is the Build plan button, inert with `blocked` as its reason. Every
 * other kind is the status capsule that replaces it after the first press.
 * `retry` and `build` say whether this viewer can act from the capsule.
 */
export type BuildLook =
	| { kind: "plan"; blocked?: string }
	| { kind: "tasks"; tip: string }
	| { kind: "building"; done: number; total: number; tip?: string }
	| { kind: "stopped"; tip: string; retry: boolean }
	| { kind: "built"; pullRequests: number; tip: string }
	| { kind: "stale"; changes: number; live: boolean; tip: string; build: boolean }
	| { kind: "rebuilding"; tip: string }
	| { kind: "failed"; tip: string; retry: boolean };

export type BuildContext = {
	state: FirstBuild;
	userId?: string;
	/** LIVE_BUILD: edits build themselves once editing settles. */
	live: boolean;
	canEdit: boolean;
	connected: boolean;
	planner: boolean;
	/**
	 * Under the remote Planner harness, no Planner client is attached to draft tasks. Only
	 * drafting needs one: starting drafted tasks, Retry and rebuilds do not.
	 */
	plannerDetached?: boolean;
	hasContent: boolean;
	unanswered: number;
};

/** Tasks of the current build that have a pull request, out of all of them. */
function progressCount(snapshot: Snapshot): { done: number; total: number } {
	let tasks = buildProgress(snapshot)?.tasks ?? [];
	let total = Math.max(tasks.length, snapshot.graph?.definition.tasks.length ?? 0, 1);
	return { done: tasks.filter(task => task.state === "completed").length, total };
}

/** Why Build plan cannot be pressed yet, or nothing when it can. */
function planBlocker(snapshot: Snapshot | undefined, context: BuildContext): string | undefined {
	if (!context.hasContent) return "Write the document first";
	if (!context.connected || !snapshot) return "Chopin isn’t connected";
	let phase = buildPhase(snapshot);
	if (phase.kind === "blocked" && phase.decisions) {
		return context.unanswered > 0
			? `Answer ${plural(context.unanswered, "open decision", "open decisions")} first`
			: "Answer the open decisions first";
	}
	if (phase.kind === "blocked" && phase.comments) {
		return "Update the document for accepted comments first";
	}
	if (phase.kind === "blocked") return "This document can’t be built yet";
	if (phase.kind === "drafting" && !context.planner) {
		return "Chopin isn’t running for this document";
	}
	if (phase.kind === "drafting" && context.plannerDetached) {
		return "Connect a Planner to this document to build";
	}
	if (!snapshot.buildReady) return "Add more detail before building";
}

/** Who else built a living document: their login, `""` when it is unknown, or nothing for you. */
function builder(snapshot: Snapshot, userId: string | undefined): string | undefined {
	if (!snapshot.live || snapshot.live.user === userId) return;
	return snapshot.builtBy ? `@${snapshot.builtBy}` : "";
}

export function buildLook(snapshot: Snapshot | undefined, context: BuildContext): BuildLook {
	let step = firstBuildStep(snapshot, context.state, context.userId);
	let sync = syncStatus(snapshot);
	if (snapshot && sync) {
		let who = builder(snapshot, context.userId);
		let rebuilding = !!snapshot.live?.rebuild
			&& ["queued", "starting", "running"].includes(snapshot.live.rebuild.state);
		if (sync.kind === "building" && rebuilding) {
			return { kind: "rebuilding", tip: "Committing the edits to the existing pull requests" };
		}
		if (sync.kind === "building") {
			let { done, total } = progressCount(snapshot);
			return { kind: "building", done, total, tip: `${done} of ${total} tasks built` };
		}
		if (sync.kind === "in-sync") {
			return {
				kind: "built",
				pullRequests: snapshot.live!.pullRequests.length,
				tip: `Every pull request matches the document${who ? ` · built by ${who}` : ""}`,
			};
		}
		if (sync.kind === "needs-attention") {
			return {
				kind: "failed",
				tip: attentionHint(snapshot) ?? "The last build didn’t finish",
				retry: false,
			};
		}
		if (sync.reason === "failed") {
			return {
				kind: "failed",
				tip: "The last build didn’t finish. Edit the document to retry.",
				retry: false,
			};
		}
		let changes = Math.max(snapshot.live!.changes ?? 1, 1);
		let tip = context.live
			? sync.reason === "waiting"
				? who
					? `Waiting for ${who}’s agent`
					: who === ""
					? "Waiting for the agent that built it"
					: "Waiting for your agent"
				: who
				? `Builds on ${who}’s agent when editing settles`
				: "Builds when editing settles"
			: who
			? `Edits since ${who} built it`
			: who === ""
			? "Edits since someone else’s build"
			: "Edits since the last build";
		return { kind: "stale", changes, live: context.live, tip, build: false };
	}
	if (!snapshot) {
		return step.view === "idle" ? { kind: "plan", blocked: "Chopin isn’t connected" } : {
			kind: "tasks",
			tip: "Breaking the document into tasks",
		};
	}
	let phase = buildPhase(snapshot);
	if (phase.kind === "building") {
		let { done, total } = progressCount(snapshot);
		let tip = startingHint(snapshot);
		return {
			kind: "building",
			done,
			total,
			tip: tip ?? `${done} of ${total} tasks built`,
		};
	}
	if (phase.kind === "done") {
		return {
			kind: "built",
			pullRequests: phase.pullRequests,
			tip: "Every task has a pull request",
		};
	}
	if (phase.kind === "stopped") {
		return {
			kind: "stopped",
			tip: "A task is blocked. Open Build to return it for changes.",
			retry: false,
		};
	}
	if (step.view === "working") return { kind: "tasks", tip: "Breaking the document into tasks" };
	if (step.view === "waiting") {
		return { kind: "tasks", tip: "Continues once the open decisions are answered" };
	}
	let retry = context.canEdit && context.connected;
	if (context.state.stage === "failed") {
		return {
			kind: "stopped",
			tip: context.state.agent
				? "Start your local agent, then retry"
				: context.state.message ?? "The build stopped before it started",
			retry,
		};
	}
	if (phase.kind === "failed") {
		return { kind: "stopped", tip: "The build stopped. Your agent may not be running.", retry };
	}
	return { kind: "plan", blocked: planBlocker(snapshot, context) };
}

/** The capsule's words; Build plan has none of its own. */
export function buildLabel(look: BuildLook): string {
	switch (look.kind) {
		case "plan":
			return "Build plan";
		case "tasks":
			return "Breaking into tasks…";
		case "building":
			return `Building · ${look.done} of ${look.total}`;
		case "stopped":
			return "Build stopped";
		case "built":
			return "Built";
		case "stale":
			return `${plural(look.changes, "change", "changes")} to build`;
		case "rebuilding":
			return "Building changes…";
		case "failed":
			return "Build failed";
	}
}

/** Build opens once there is a build, or a press under way, to show. */
export function buildTabReady(snapshot: Snapshot | undefined, look: BuildLook): boolean {
	return look.kind !== "plan" || !!snapshot && hasBuilt(snapshot);
}
