import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import * as Service from "../plan/service";
import type { Server } from "bun";

import type { Plan } from "../plan/service";

import type { SocketData } from "../wire";
import type { EffectCommands } from "./service";

import { activeSettleDeferral, effectivePreference } from "./preference";

import { sameSource } from "./card-prompts";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
export function createCardSuggestion(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
): Pick<EffectCommands, "suggest"> {
	return {
		suggest: async (id, input) => {
			await Service.exclusive(plan, async () => {
				if (Service.implementationActive(plan)) throw new Error("implementation is active");
				let record = plan.records.get(id);
				if (!record) throw new Error("card is missing");
				let thread = plan.conversationPlan.threads.find(item => item.id === record.threadId);
				if (thread && activeSettleDeferral(thread, plan.conversationPlan.events)) return;
				if (thread?.status === "reopened" && !thread.pendingSettle) return;
				if (thread?.pendingSettle) {
					let current = effectivePreference(thread, plan.conversationPlan.events);
					if (!sameSource(current, input.optionId, input.messageIds)) return;
				}
				let applied = await Questions.suggest(
					plan,
					server,
					roomId,
					id,
					input.optionId ? { optionId: input.optionId, messageIds: input.messageIds } : undefined,
					true,
				);
				if (Service.implementationActive(plan)) throw new Error("implementation is active");
				if (!applied && Questions.isOpenStatus(plan.records.get(id)?.status ?? "cancelled")) {
					let live = Store.get(plan.questions, id);
					if (!live || live.claim) throw new Error("card is temporarily unavailable");
				}
			});
		},
	};
}
