import type { HostInput } from "@bastani/atomic";
import type { FullPlanner } from "../atomic/full";
import type { HumanInputStatus } from "../atomic/human-input";
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
		humanInput?: (report: (status: HumanInputStatus) => void) => HostInput;
		/** Stops or resumes the client's workflow runs; set while the session is open. */
		control?: (action: "stop" | "resume", runId?: string) => Promise<void>;
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
