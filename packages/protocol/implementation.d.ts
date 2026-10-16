import type { Frame, Request } from "./index";
import type { Plan } from "./plan";

type KIND<K extends string> = Frame & { kind: K };

export type CheckoutContext = { repository: string; branch?: string; commit: string };
export type BuildRequest = {
	id: string;
	retryOf?: string;
	user: string;
	connectionId: string;
	/** The paired machine it runs on; builds stored before machines were recorded have none. */
	machineId?: string;
	/** That machine's connection ran as a background service. */
	machineService?: true;
	repositoryId: string;
	checkout: CheckoutContext;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	createdAt: string;
	expiresAt: number;
	state: "queued" | "starting" | "running" | "stopped" | "failed";
	session?: string;
	error?: string;
	/** Latest coding-agent activity; `at` changes when its description changes. */
	activity?: { text: string; at: string };
	/** A human Stop suppresses automatic work for edits up through this document revision. */
	stoppedAtRevision?: number;
	/** The connector's key for the report that set `state`, so a retry of it is recognized. */
	reportKey?: string;
	/** A rebuild carries edits since `baseRevision` onto a live build's pull requests. */
	kind?: "rebuild";
	baseRevision?: number;
	targetRevision?: number;
};
/** A living document's last delivered build and its sync state, without the built source. */
export type LiveSnapshot = {
	buildId: string;
	user: string;
	repositoryId: string;
	/** The builder's checkout; sent only to the builder. */
	checkout?: CheckoutContext;
	baseRevision: number;
	pullRequests: string[];
	/** Tasks the first build stopped short of; the next rebuild finishes them. */
	outstanding?: string[];
	/**
	 * The outstanding tasks still unfinished, with any blocker. Only an edit starts the rebuild
	 * that retries them, so an in-sync document with any of these needs attention.
	 */
	outstandingTasks?: Array<{
		id: string;
		title: string;
		state: "queued" | "in_progress" | "blocked";
		blocker?: string;
	}>;
	/** Rebuilds that landed with no commit or task: the document needed no code change. */
	noChange?: Array<{ buildId: string; revision: number; summary: string; at: string }>;
	commits: Array<{
		pullRequest: string;
		sha: string;
		message: string;
		/** The document revision this commit brought its pull request up to. */
		revision: number;
		at: string;
	}>;
	/** The first build's tasks, then every rebuild's, each with its last reported progress. */
	tasks: Array<
		NonNullable<ImplementationSnapshot["graph"]>["definition"]["tasks"][number] & {
			progress?: Plan.ImplementationProgress["tasks"][number];
		}
	>;
	/**
	 * The latest rebuild; its state distinguishes building from failed. Only the builder sees
	 * which connection, checkout and session ran it.
	 */
	rebuild?: BuildRequest | LiveRebuild;
	/** The current document differs from the source last built onto the pull requests. */
	outOfSync: boolean;
	/** Top-level blocks added, removed or changed since that source; at least 1 when out of sync. */
	changes?: number;
	/**
	 * A workspace of the live build's user is connected for this document. Sent only to the
	 * builder, so others never learn when someone's laptop is online.
	 */
	builderConnected?: boolean;
};
/** The machine a build runs or ran on, as everyone who can see the build sees it. */
export type BuildMachine = {
	/** The machine's paired name, as its owner last renamed it. */
	label: string;
	/** It ran as a background service rather than an interactive session. */
	service: boolean;
	/**
	 * Whether the machine is connected now. Sent only to the build's own starter, so others never
	 * learn when someone's machine is online.
	 */
	connected?: boolean;
};
/** A rebuild as people other than its builder see it. */
export type LiveRebuild = Omit<BuildRequest, "connectionId" | "checkout" | "session">;
export type ImplementationSnapshot = {
	revision: number;
	planRevision: number;
	graph?: {
		number: number;
		revision: number;
		planRevision: number;
		state: "draft" | "approved" | "locked" | "superseded";
		definition: {
			tasks: Array<{
				id: string;
				title: string;
				context: string;
				goal: string;
				acceptance: string[];
				dependsOn: string[];
			}>;
		};
	};
	build?: BuildRequest;
	/** The GitHub login of whoever requested `build`, when it is still known. */
	startedBy?: string;
	/** The GitHub login of the living document's builder (`live.user`), when it is still known. */
	builtBy?: string;
	/**
	 * Where `build`, `live.rebuild` and the live build (`live.buildId`) run or ran, by build id. A
	 * build stored before machines were recorded, or whose machine record is gone, has no entry.
	 */
	buildMachines?: Record<string, BuildMachine>;
	/** Whether the viewer has a connected local agent for this repository; it may be busy. */
	localAgent: boolean;
	blockers: string[];
	/** Required investigations, with concrete reasons; completion still needs evidence review. */
	buildInvestigations?: Array<{ id: string; brief: string; reason: string }>;
	/** No unresolved decisions, accepted changes, or required investigations. */
	buildReady: boolean;
	/** `build` is queued on a connection that starts it once its running prototype finishes. */
	waitingForPrototype?: true;
	/**
	 * `build` is queued behind another document's build on the same agent; it starts when that
	 * one finishes. `title` names the other document when it is known.
	 */
	waitingForDocument?: { title?: string };
	/**
	 * A one-click Build plan is waiting for its tasks: `by` (a user id) pressed it at `revision`.
	 * It holds through open decisions and reloads until the build starts or is cancelled.
	 */
	buildRequested?: { by: string; revision: number };
	lifecycle: Pick<Plan.Lifecycle, "execution" | "activity" | "history">;
	live?: LiveSnapshot;
};

/**
 * Asking the Planner for implementation tasks.
 *
 * Opening Build asks for them. The request starts a Planner turn without a
 * member message: Chat records only a system notice of who asked, as it does
 * for an accepted comment. One request per document is live at a time;
 * asking again while it is queued or running returns it.
 */
export declare namespace Implementation {
	export type Incoming = Request<Draft>;
	export type Outgoing = Drafted | Drafting | Readiness;

	/** Draft or revise the tasks for the document as it now stands. */
	export type Draft = KIND<"implementation:draft"> & {
		/** UUIDv4 for this attempt. */
		requestId: string;
		/** The revision the asker saw; the server drafts against its current revision. */
		planRevision: number;
		/** Asked by the one-click Build plan, which starts the tasks once they are drafted. */
		build?: true;
	};

	/** The document's live request, new or `existing`; `ended` if its turn finished first. */
	export type Drafted = KIND<"implementation:draft"> & {
		id: string;
		planRevision: number;
		state: "queued" | "running" | "ended";
		existing: boolean;
	};

	/** Broadcast as a request's turn starts and ends; `ended` says nothing of whether tasks arrived. */
	export type Drafting = KIND<"implementation:drafting"> & {
		id: string;
		planRevision: number;
		state: "queued" | "running" | "ended";
	};

	/** Broadcast when a document's build readiness judgement changes; read the snapshot again. */
	export type Readiness = KIND<"implementation:readiness"> & {
		planRevision: number;
		ready: boolean;
	};
}
