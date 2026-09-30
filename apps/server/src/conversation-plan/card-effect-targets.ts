import * as Questions from "../questions/service";

import * as Service from "../plan/service";
import type { Server } from "bun";

import type { Plan } from "../plan/service";

import type { SocketData } from "../wire";
import type { EffectCommands, Processor } from "./service";
import { proseIntent } from "./prose-job";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations/property nodes; synchronous wrappers only.
export function createCardTargets(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	processor: Processor,
): Pick<EffectCommands, "proseReady" | "target" | "insertCard" | "link" | "addOption"> {
	return {
		proseReady: (threadId, id, trigger) => {
			let thread = plan.conversationPlan.threads.find(item => item.id === threadId);
			let record = plan.records.get(id);
			return !!record && thread?.questionnaireId === id && record.threadId === threadId
				&& proseIntent(record)?.trigger === trigger;
		},
		target: threadId => {
			let id = plan.conversationPlan.threads.find(item => item.id === threadId)?.questionnaireId;
			if (!id) return { kind: "unlinked" };
			let record = plan.records.get(id);
			if (!record) return { kind: "unlinked" };
			return record.status === "open" || record.status === "reopened"
				? { kind: "open", id }
				: { kind: "closed" };
		},
		insertCard: async input => {
			let linked = plan.conversationPlan.threads.find(item => item.id === input.threadId)
				?.questionnaireId;
			if (linked && !plan.records.has(linked)) throw new Error("linked card is missing");
			return await Questions.insertConversationCard(plan, server, roomId, input);
		},
		link: async (threadId, questionnaireId) => {
			await processor.record(state => {
				let thread = state.threads.find(item => item.id === threadId);
				if (!thread) throw new Error("card link thread is missing");
				if (thread.questionnaireId === questionnaireId) return;
				if (thread.questionnaireId) throw new Error("thread already has a different card");
				return {
					id: `card:${questionnaireId}:linked`,
					type: "card.linked",
					threadId,
					observedThreadVersion: thread.version,
					origin: "classifier",
					actor: { kind: "classifier" },
					at: Math.floor(Date.now() / 1_000),
					questionnaireId,
				};
			});
		},
		addOption: async (id, input) => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			let record = plan.records.get(id);
			if (!record) throw new Error("card is missing");
			let existing = record.definition.questions[0]?.options.find(option =>
				option.id === input.optionId
			);
			if (existing) {
				// A later title refinement may have changed this option's label.
				if (record.optionOrigins[input.optionId]?.origin === "chat") return;
				console.error("[conversation-plan] option ID belongs to another origin:", input.optionId);
				return;
			}
			let result = await Questions.addServerOption(plan, server, roomId, id, {
				...input,
				origin: "chat",
			});
			if (!result.ok) {
				if (Service.implementationActive(plan)) throw new Error("implementation is active");
				if (
					result.reason === "closed" && Questions.isOpenStatus(
						plan.records.get(id)?.status ?? "cancelled",
					)
				) throw new Error("card is temporarily unavailable");
				console.error("[conversation-plan] could not represent a quoted option:", result);
			}
		},
	};
}
