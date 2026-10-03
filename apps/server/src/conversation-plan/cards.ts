import * as Chat from "../chat/service";

import type { Server } from "bun";

import type { Plan } from "../plan/service";

import type { SocketData } from "../wire";
import type { EffectCommands, Processor } from "./service";

import { createCardTargets } from "./card-effect-targets";
import { createCardSuggestion } from "./card-effect-suggestion";
import { createCardPrompts } from "./card-effect-prompts";
import { createScopedNotice } from "./card-effect-scoped";

export { mirroredEvent } from "./card-mirror";
export { mirrorCard, wakeCardMirror } from "./card-mirror-runner";
export { promptText, shouldPrompt } from "./card-prompts";

export function cardEffects(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	processor: Processor,
	enqueueJob: EffectCommands["enqueueJob"] | undefined,
	announcer: Chat.Announcer,
): EffectCommands {
	return {
		...createCardTargets(plan, server, roomId, processor),
		...createCardSuggestion(plan, server, roomId),
		...createCardPrompts(plan, server, roomId, announcer),
		...createScopedNotice(plan, announcer),
		...(enqueueJob ? { enqueueJob } : {}),
		report: error => console.error("[conversation-plan] card effect failed:", error),
	};
}
