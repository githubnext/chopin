import type { ConversationPlan, Request } from "@chopin/protocol";
import type { AuthorizationResult, Socket } from "../wire";
import type { Room } from "../rooms";
import type * as Chat from "../chat/service";
import { fail, reply } from "../wire";
import { handleScopedChoiceSave } from "./save-command";
import type { createConversationRuntime } from "./runtime";

type Command = Request<
	| ConversationPlan.Correct
	| ConversationPlan.SaveScopedChoice
	| ConversationPlan.Retry
	| ConversationPlan.RetryJob
>;
type CommandDeps = {
	enabled: boolean;
	runtime: ReturnType<typeof createConversationRuntime>;
	unavailable: (id: string) => boolean;
	refreshAccess: () => Promise<AuthorizationResult>;
	chat: () => Chat.Room;
};

/** The socket admission layer rechecks write access before dispatching these commands. */
export async function handleConversationCommand(
	frame: Command,
	room: Room,
	ws: Socket,
	deps: CommandDeps,
): Promise<void> {
	switch (frame.kind) {
		case "conversation-plan:correct": {
			try {
				if (!deps.enabled) throw new Error("conversation analysis is disabled");
				if (!ws.data.canEdit || ws.data.channelArchivedAt || deps.unavailable(room.id)) {
					throw new Error("repository write access is required");
				}
				let processor = room.plan && deps.runtime.processor(room.plan);
				if (!processor) throw new Error("document is not open");
				let result = await processor.correct({
					actionId: frame.actionId,
					threadId: frame.threadId,
					expectedVersion: frame.expectedVersion,
					change: frame.change,
				}, { kind: "member", handle: ws.data.handle });
				reply(ws, frame.rid, { kind: "conversation-plan:correct", ts: 0, ...result });
			} catch (error) {
				fail(ws, frame.rid, error instanceof Error ? error.message : "cannot correct card");
			}
			return;
		}

		case "conversation-plan:scoped-choice-save":
			await handleScopedChoiceSave(frame, {
				refreshAccess: () => deps.refreshAccess(),
				conversationPlanEnabled: deps.enabled,
				canEdit: () => ws.data.canEdit,
				archived: () => !!ws.data.channelArchivedAt,
				roomClosing: () =>
					!!room.closing || deps.unavailable(room.id)
					|| deps.unavailable(room.id),
				actor: () => ({ kind: "member", handle: ws.data.handle }),
				processor: () => room.plan && deps.runtime.processor(room.plan),
				reply: (rid, result) => reply(ws, rid, result),
				fail: (rid, message) => fail(ws, rid, message),
			});
			return;

		case "conversation-plan:retry": {
			try {
				if (!deps.enabled) throw new Error("conversation analysis is disabled");
				if (!ws.data.canEdit || ws.data.channelArchivedAt || deps.unavailable(room.id)) {
					throw new Error("repository write access is required");
				}
				let processor = room.plan && deps.runtime.processor(room.plan);
				if (!processor) throw new Error("document is not open");
				let result = await processor.retry(frame.actionId, frame.messageId, {
					kind: "member",
					handle: ws.data.handle,
				});
				reply(ws, frame.rid, { kind: "conversation-plan:retry", ts: 0, ...result });
			} catch (error) {
				fail(ws, frame.rid, error instanceof Error ? error.message : "cannot retry analysis");
			}
			return;
		}

		case "conversation-plan:retry-job": {
			try {
				if (!deps.enabled) throw new Error("conversation analysis is disabled");
				if (
					!ws.data.canEdit || ws.data.channelArchivedAt || room.closing
					|| deps.unavailable(room.id) || deps.unavailable(room.id)
				) throw new Error("repository write access is required");
				let opened = room.plan;
				let jobs = opened && deps.runtime.jobs(opened);
				if (!opened || !jobs) throw new Error("document is not open");
				let found = jobs.jobs().find(job => job.id === frame.jobId);
				let claimant = found ? deps.chat() : undefined;
				let previous = found && claimant
					? deps.runtime.contexts.remember(opened, found.trigger, claimant)
					: undefined;
				let queued: boolean;
				try {
					queued = await jobs.retry(frame.jobId);
				} catch (error) {
					if (found && claimant) {
						deps.runtime.contexts.restore(opened, found.trigger, claimant, previous);
					}
					throw error;
				}
				if (!queued && found && claimant) {
					deps.runtime.contexts.restore(opened, found.trigger, claimant, previous);
				}
				if (
					room.plan !== opened || room.closing || deps.unavailable(room.id)
					|| deps.unavailable(room.id) || ws.data.channelArchivedAt || !ws.data.canEdit
				) throw new Error("document is unavailable");
				reply(ws, frame.rid, {
					kind: "conversation-plan:retry-job",
					ts: 0,
					jobId: frame.jobId,
					queued,
				});
			} catch (error) {
				fail(ws, frame.rid, error instanceof Error ? error.message : "cannot retry job");
			}
			return;
		}
	}
}
