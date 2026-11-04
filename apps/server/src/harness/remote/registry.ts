import type { FullPlanner } from "../atomic/full";
import type { HumanInput, HumanInputStatus } from "../atomic/human-input";
import type { AgentLink } from "./link";

/**
 * What Chopin keeps for one Planner session whose model runs in an attached
 * client. Run state mirrors a full Atomic Planner's, reported by the client.
 */
export type RemotePlanner =
	& Pick<FullPlanner, "runs" | "onRuns" | "rootOf" | "waiters" | "activeTools" | "toolReport">
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
		/** The drop kept a Stop the client had not confirmed, to be delivered when it returns. */
		keptStop?: boolean;
		/** Heard when `suspended` changes: the link dropped, or the client came back on another. */
		linkChanged?: () => void;
		/**
		 * Stops or resumes the client's workflow runs; set while the session is open. A Stop the
		 * link's drop kept for the client's return, whether pressed while it was down or already
		 * sent and unanswered when it dropped, resolves `held` rather than done, and one the client
		 * did not answer in time `unconfirmed`. A Resume is refused while the link is down.
		 */
		control?: (
			action: "stop" | "resume",
			runId?: string,
		) => Promise<void | "held" | "unconfirmed">;
		/**
		 * Stops the server's host tools for the next turn. That turn aborts it when it
		 * ends without its caller stopping it, so a host tool still running, such as an
		 * open Decision, ends with the turn instead of holding it open.
		 */
		hostTools?: AbortController;
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
