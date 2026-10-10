import type { Frame, Request } from "./index";
import type { Plan } from "./plan";

type KIND<K extends string> = Frame & { kind: K };

export type CheckoutContext = { repository: string; branch?: string; commit: string };
export type BuildRequest = {
	id: string;
	retryOf?: string;
	user: string;
	connectionId: string;
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
	checkout: CheckoutContext;
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
	/** The latest rebuild; its state distinguishes building from failed. */
	rebuild?: BuildRequest;
	/** The current document differs from the source last built onto the pull requests. */
	outOfSync: boolean;
	/** A workspace of the live build's user is connected for this document. */
	builderConnected: boolean;
};
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
	/** Whether the viewer has a connected local agent for this repository; it may be busy. */
	localAgent: boolean;
	blockers: string[];
	/**
	 * The document reads as complete enough to build and nothing blocks it.
	 * Judged in memory once edits settle, so it may lag the latest revision.
	 */
	buildReady: boolean;
	/** `build` is queued on a connection that starts it once its running prototype finishes. */
	waitingForPrototype?: true;
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
