import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { Dependencies, Member, State } from "./processor-types";
import { applyCorrection, enqueue, retryMessage } from "./domain";
import { effectsFor } from "./effects";
import { assertOptionCapacity } from "./option-capacity";
import { applyEvent } from "./events";
import { assertStateShape, MAX_ANALYSIS, MAX_QUEUE } from "./validation";
import { QUESTION_SET_VERSION } from "./question-shared";
import { appendEffects } from "./processor-fields";
import { RESEARCH_QUESTION_SET } from "./research-interpreter";

export function createCommands(
	deps: Dependencies,
	plan: Dependencies["plan"],
	active: () => boolean,
	publish: () => void,
	wake: () => void,
) {
	async function accept(message: Chat.Entry): Promise<void> {
		await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			let previous = plan.conversationPlan;
			let index = plan.chat.entries.length;
			plan.chat.entries.push(message);
			try {
				if (previous.queue.length < MAX_QUEUE) {
					plan.conversationPlan = enqueue(previous, message.id);
				} else {
					let skipped: ConversationPlan.AnalysisRecord = {
						messageId: message.id,
						questionSetVersion: QUESTION_SET_VERSION,
						modelVersion: "unavailable",
						status: "unlinked",
						passes: [],
						policyGate: "queue full; skipped",
						eventIds: [],
					};
					let next = {
						...previous,
						revision: previous.revision + 1,
						analysis: [...previous.analysis, skipped].slice(-MAX_ANALYSIS),
					};
					assertStateShape(next);
					plan.conversationPlan = next;
				}
				if (deps.researchInterpret && message.author.kind === "member") {
					let state = plan.conversationPlan.research!;
					plan.conversationPlan = {
						...plan.conversationPlan,
						research: state.queue.length < MAX_QUEUE
							? {
								...state,
								queue: [...state.queue, { messageId: message.id, status: "pending", attempts: 0 }],
							}
							: {
								...state,
								analysis: [...state.analysis, {
									messageId: message.id,
									questionSetVersion: RESEARCH_QUESTION_SET,
									modelVersion: "unavailable",
									status: "unlinked" as const,
									answers: {},
									policyGate: "research queue full",
									latencyMs: 0,
								}].slice(-MAX_ANALYSIS),
							},
					};
				}
				await deps.persist();
			} catch (error) {
				plan.conversationPlan = previous;
				plan.chat.entries.splice(index, 1);
				throw error;
			}
		});
	}

	function afterMessage(): void {
		publish();
		wake();
	}

	async function correct(action: ConversationPlan.CorrectionAction, actor: Member) {
		let changed = false;
		let state = await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			let previous = plan.conversationPlan;
			let pending = plan.conversationPlanPendingEffects;
			let next = applyCorrection(previous, action, actor, Date.now(), plan.chat.entries);
			if (next === previous) return previous;
			if (action.change.kind === "add-excerpt") {
				let thread = next.threads.find(item => item.id === action.threadId);
				let record = thread?.questionnaireId && plan.records.get(thread.questionnaireId);
				if (!record || !["open", "reopened"].includes(record.status)) {
					throw new Error("The decision card is no longer open");
				}
			}
			plan.conversationPlan = next;
			try {
				let accepted = next.events.at(-1)!;
				plan.conversationPlanPendingEffects = appendEffects(
					plan,
					effectsFor([accepted], next, undefined, plan.records),
				);
				assertOptionCapacity(plan);
				await deps.persist();
				changed = true;
				return next;
			} catch (error) {
				plan.conversationPlan = previous;
				plan.conversationPlanPendingEffects = pending;
				throw error;
			}
		});
		if (changed) {
			publish();
			wake();
		}
		return { eventId: `human:${actor.handle}:${action.actionId}`, revision: state.revision };
	}

	async function record(
		make: ConversationPlan.Event | ((state: State) => ConversationPlan.Event | undefined),
		pendingCardActionId?: string,
	) {
		let changed = false;
		let consumed = false;
		await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			let previous = plan.conversationPlan;
			let pending = plan.conversationPlanPendingEffects;
			let actions = plan.pendingCardActions;
			if (pendingCardActionId && actions[0]?.id !== pendingCardActionId) {
				if (previous.events.some(event => event.id === pendingCardActionId)) return;
				throw new Error("card action is not at the FIFO head");
			}
			let event = typeof make === "function" ? make(previous) : make;
			if (pendingCardActionId && event && event.id !== pendingCardActionId) {
				throw new Error("card action ID does not match mirror event");
			}
			let next = event ? applyEvent(previous, event) : previous;
			if (next === previous && !pendingCardActionId) return;
			plan.conversationPlan = next;
			if (pendingCardActionId) plan.pendingCardActions = actions.slice(1);
			try {
				if (next !== previous && event) {
					plan.conversationPlanPendingEffects = appendEffects(
						plan,
						effectsFor([event], next, undefined, plan.records),
					);
				}
				await deps.persist();
				changed = next !== previous;
				consumed = !!pendingCardActionId;
			} catch (error) {
				plan.conversationPlan = previous;
				plan.conversationPlanPendingEffects = pending;
				plan.pendingCardActions = actions;
				throw error;
			}
		});
		if (changed) publish();
		if (changed || consumed) wake();
		return changed;
	}

	async function retry(actionId: string, messageId: string, actor: Member) {
		let changed = false;
		let queued = await deps.exclusive(async () => {
			if (!active()) throw new Error("conversation analysis is unavailable");
			if (
				actor.kind !== "member" || !actor.handle
				|| typeof actionId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(actionId)
				|| typeof messageId !== "string" || !messageId || messageId.length > 200
			) throw new Error("invalid analysis retry");
			let id = `human:${actor.handle}:${actionId}`;
			let existing = plan.conversationPlanRetries.find(item => item.id === id);
			if (existing) {
				if (existing.messageId !== messageId) throw new Error("analysis retry ID collision");
				return plan.conversationPlan.queue.some(item =>
					item.messageId === messageId && item.status === "pending"
				);
			}
			if (plan.conversationPlanRetries.length >= 4096) {
				throw new Error("analysis retry history is full");
			}
			let previous = plan.conversationPlan;
			let retries = plan.conversationPlanRetries;
			plan.conversationPlan = retryMessage(previous, messageId);
			plan.conversationPlanRetries = [...retries, { id, messageId }];
			try {
				await deps.persist();
				changed = true;
				return true;
			} catch (error) {
				plan.conversationPlan = previous;
				plan.conversationPlanRetries = retries;
				throw error;
			}
		});
		if (changed) {
			publish();
			wake();
		}
		return { messageId, queued };
	}
	return { accept, afterMessage, correct, record, retry };
}
