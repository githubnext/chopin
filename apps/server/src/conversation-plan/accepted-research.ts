import * as Chat from "../chat/service";
import { ResearchWorkspaceError } from "../research/service";
import type { ResearchWorkspaceService } from "../research/service";
import type { ConversationPlan } from "@chopin/protocol";
import type { HostedAuth } from "../auth/routes";
import type { AuthorizationResult, Socket } from "../wire";
import type * as Rooms from "../rooms";
import type * as Service from "../plan/service";

type AcceptedResearchDeps = {
	research: () => ResearchWorkspaceService | undefined;
	auth: HostedAuth;
	refreshAccess: (ws: Socket, force: boolean) => Promise<AuthorizationResult>;
	unavailable: (id: string) => boolean;
	ownerAvailable: (id: string) => Promise<void>;
	placeReference: (channelId: string, workspaceId: string) => Promise<"placed" | "deferred">;
	scheduleRecovery: (deferred: number) => void;
};

/** Retained consent execution; repository and process owner are rechecked at enqueue. */
export async function startAcceptedResearch(
	room: Rooms.Room,
	ws: Socket,
	opened: Service.Plan,
	offer: ConversationPlan.ResearchOffer,
	deps: AcceptedResearchDeps,
): Promise<
	| { execution: "started"; researchRequestId: string }
	| { execution: "pending-owner" }
> {
	let service = deps.research();
	if (!service || !offer.action) throw new Error("research workspaces are unavailable");
	let repository = {
		id: ws.data.repositoryId,
		owner: ws.data.repositoryOwner,
		name: ws.data.repositoryName,
		defaultBranch: ws.data.repositoryDefaultBranch,
	};
	let ownerReady = async () => {
		let access = await deps.refreshAccess(ws, true);
		if (
			access !== "allowed" || !ws.data.canEdit || ws.data.channelArchivedAt
			|| room.plan !== opened || room.closing || deps.unavailable(room.id)
			|| deps.unavailable(room.id)
		) return false;
		try {
			await Chat.resolveOwner(deps.auth, repository, room.id, ws.data.sessionId);
			return true;
		} catch {
			return false;
		}
	};
	if (!await ownerReady()) return { execution: "pending-owner" };
	let ownerUnavailable = false;
	try {
		let created = await service.startPlannerInline({
			channelId: room.id,
			question: offer.workflow?.accepted?.brief ?? offer.brief,
			...(offer.workflow?.accepted ? { requestKey: offer.workflow.accepted.executionKey } : {}),
			originMessageId: offer.source.messageId,
			requestedBy: offer.action.principalId,
			requestedByHandle: offer.action.actor.handle,
			beforeStart: async () => {
				if (!await ownerReady()) {
					ownerUnavailable = true;
					throw new Error("research owner is unavailable");
				}
				await deps.ownerAvailable(room.id);
			},
			placeReference: id => deps.placeReference(room.id, id),
		});
		return { execution: "started", researchRequestId: created.request.id };
	} catch (error) {
		if (ownerUnavailable) return { execution: "pending-owner" };
		if (error instanceof ResearchWorkspaceError && error.code === "not-ready") {
			deps.scheduleRecovery(1);
		}
		throw error;
	}
}
