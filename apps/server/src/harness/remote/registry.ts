import type { FullPlanner } from "../atomic/full";
import type { HumanInput, HumanInputStatus } from "../atomic/human-input";
import type { AgentLink, RebuiltDocument } from "./link";

/** What Chopin keeps for one Planner session whose model runs in an attached client. */
export type RemotePlanner =
	& Pick<FullPlanner, "activeTools" | "toolReport">
	& {
		channelId: string;
		/** A background job's session: the client may offer only Chopin's tools and ask nothing. */
		isolated: boolean;
		/** Decisions for one client input request; absent for an isolated session. */
		humanInput?: (report: (status: HumanInputStatus) => void) => HumanInput;
		/**
		 * Keeps the session while a client request has no result at its client: call the returned
		 * function once the result has been sent, or can never be. A session let go before that
		 * would turn an answer into a cancellation.
		 */
		holdInput?: () => () => void;
		/**
		 * The client's link dropped unexpectedly and the session waits for it to resume: nothing
		 * it holds has ended, but nothing can reach it either.
		 */
		suspended?: boolean;
		/** The server is going down: its links closing says nothing about the client. */
		stopping?: boolean;
		/**
		 * Stops the server's host tools for the next turn. That turn aborts it when it
		 * ends without its caller stopping it, so a host tool still running, such as an
		 * open Decision, ends with the turn instead of holding it open.
		 */
		hostTools?: AbortController;
		/** The Chat message the next turn answers, taken by that turn like `hostTools`. */
		turnMessage?: { id: string; retry?: true };
		/**
		 * What the session opens on, as its first turn would run it: the document's chosen model and
		 * thinking level checked against the client's catalog, and the operator's `MODEL` where no
		 * model was chosen. A client that offered `session-choice` is told them in `start` or `fork`.
		 */
		choice?: { model?: string; thinkingLevel?: string };
		/** Parent session and turn to branch from when starting a thread session. */
		forkFrom?: { session: string; turn?: string };
		/** Set `true` when the client accepted `fork` over `session-forks`. */
		forkedNatively?: boolean;
		/** Reports `{ session, turn }` as each remote turn starts, so a thread can fork from it. */
		onRemoteTurn?: (point: { session: string; turn: string }) => void;
		/**
		 * A session a restart rebuilt, which no turn of this process opened: how what its client
		 * reports and asks reaches the document.
		 */
		rebuilt?: RebuiltDocument;
	};

let planners = new Map<string, RemotePlanner>();
let links = new Map<string, AgentLink>();

export function registerRemotePlanner(sessionId: string, planner: RemotePlanner): () => void {
	if (planners.has(sessionId)) throw new Error("Remote Planner session is already registered");
	planners.set(sessionId, planner);
	return () => {
		if (planners.get(sessionId) === planner) planners.delete(sessionId);
	};
}

export function remotePlanner(sessionId: string): RemotePlanner | undefined {
	return planners.get(sessionId);
}

/** Records the link attached as a document's Planner; `PlannerAttachments` admits one per document. */
export function attachLink(channelId: string, link: AgentLink): () => void {
	links.set(channelId, link);
	return () => {
		if (links.get(channelId) === link) links.delete(channelId);
	};
}

export function attachedLink(channelId: string): AgentLink | undefined {
	return links.get(channelId);
}
