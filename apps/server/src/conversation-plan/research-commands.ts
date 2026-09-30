import { fail, reply } from "../wire";
import * as Service from "../plan/service";
import type { ConversationPlan, Request } from "@chopin/protocol";
import type { AuthorizationResult, Socket } from "../wire";
import type * as Rooms from "../rooms";
import type { Processor } from "./service";
import type { createConversationRuntime } from "./runtime";
import type { ResearchWorkspaceService } from "../research/service";

type ResearchCommand = Request<ConversationPlan.ResearchConsent | ConversationPlan.ResearchLink>;
type ResearchCommandDeps = {
	enabled: boolean;
	runtime: ReturnType<typeof createConversationRuntime>;
	research: () => ResearchWorkspaceService | undefined;
	unavailable: (id: string) => boolean;
	refreshAccess: (ws: Socket, force: boolean) => Promise<AuthorizationResult>;
	start: (
		room: Rooms.Room,
		ws: Socket,
		opened: Service.Plan,
		offer: ConversationPlan.ResearchOffer,
	) => Promise<
		{ execution: "started"; researchRequestId: string } | { execution: "pending-owner" }
	>;
};

/** Reads recheck repository access; consent requires the existing writer admission. */
export async function handleResearchCommand(
	frame: ResearchCommand,
	room: Rooms.Room,
	ws: Socket,
	deps: ResearchCommandDeps,
): Promise<void> {
	switch (frame.kind) {
		case "conversation-plan:research": {
			try {
				if (!deps.enabled) throw new Error("conversation analysis is disabled");
				if (
					!ws.data.canEdit || ws.data.channelArchivedAt || room.closing
					|| deps.unavailable(room.id) || deps.unavailable(room.id)
				) throw new Error("repository write access is required");
				let opened = room.plan;
				let processor = opened && deps.runtime.processor(opened);
				if (!opened || !processor) throw new Error("document is not open");
				let result = await processor.researchConsent(
					{
						offerId: frame.offerId,
						choice: frame.choice,
						actionId: frame.actionId,
					} as Parameters<Processor["researchConsent"]>[0],
					{
						kind: "member",
						handle: ws.data.handle,
					},
					ws.data.principalId,
					offer => deps.start(room, ws, opened, offer),
				);
				reply(ws, frame.rid, { kind: "conversation-plan:research", ts: 0, ...result });
			} catch (error) {
				fail(
					ws,
					frame.rid,
					error instanceof Error ? error.message : "cannot act on research offer",
				);
			}
			return;
		}

		case "conversation-plan:research-link": {
			try {
				let access = await deps.refreshAccess(ws, true);
				if (access === "unavailable") {
					fail(ws, frame.rid, "authorization is temporarily unavailable");
					return;
				}
				if (access === "denied") {
					fail(ws, frame.rid, "authorization expired");
					ws.close(4403, "authorization expired");
					return;
				}
				if (
					typeof frame.offerId !== "string" || !frame.offerId
					|| frame.offerId.length > 200
				) throw new Error("invalid research offer id");
				let opened = room.plan;
				let research = deps.research();
				if (!opened || !research) throw new Error("document is not open");
				let offer = await Service.exclusive(opened, async () => {
					let current = opened.conversationPlan?.researchOffers?.find(item =>
						item.id === frame.offerId
					);
					return current && structuredClone(current);
				});
				if (offer?.status !== "accepted") throw new Error("accepted research offer not found");
				let link = await research.acceptedOfferLink(room.id, offer);
				reply(ws, frame.rid, {
					kind: "conversation-plan:research-link",
					ts: 0,
					offerId: offer.id,
					...link,
				});
			} catch (error) {
				fail(ws, frame.rid, error instanceof Error ? error.message : "cannot read research offer");
			}
			return;
		}
	}
}
