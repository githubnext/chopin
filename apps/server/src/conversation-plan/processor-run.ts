import { isDeepStrictEqual } from "node:util";
import type { Dependencies, State } from "./processor-types";
import { type Interpretation, interpretMessage } from "./interpret";
import { completeAnalysis } from "./domain";
import { assertEventCapacity, ConversationCapacityError, currentScopedProposal } from "./events";
import { effectsFor } from "./effects";
import { assertOptionCapacity } from "./option-capacity";
import { cardCycle, linkedCardOptions } from "./processor-card-context";
import { admitResearchOffer } from "./processor-research-admission";
import { appendEffects, failure, sameThreads } from "./processor-fields";
// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export function createRun(
	deps: Dependencies,
	plan: Dependencies["plan"],
	active: () => boolean,
	controller: AbortController,
	publish: () => void,
	recover: () => Promise<void>,
	drainEffects: () => Promise<void>,
) {
	async function run(): Promise<boolean> {
		await recover();
		await drainEffects();
		while (active()) {
			let stale = 0;
			while (active()) {
				let input = await deps.exclusive(async () => {
					if (!active()) return undefined;
					let item = plan.conversationPlan.queue.find(item => item.status === "pending");
					if (!item) return undefined;
					let index = plan.chat.entries.findIndex(entry => entry.id === item.messageId);
					if (index < 0) throw new Error("queued conversation message is missing");
					return {
						channelId: plan.id,
						message: structuredClone(plan.chat.entries[index]!),
						recent: structuredClone(plan.chat.entries.slice(0, index).slice(-12)),
						state: structuredClone(plan.conversationPlan),
						linkedCards: linkedCardOptions(plan, plan.conversationPlan),
						cardCycles: new Map(plan.conversationPlan.threads.map(thread => [
							thread.id,
							cardCycle(plan, thread),
						])),
					};
				});
				if (!input) return false;
				let { cardCycles, ...interpretInput } = input;
				let interpretation: Interpretation;
				try {
					interpretation = await (deps.interpret ?? interpretMessage)(
						interpretInput,
						controller.signal,
					);
				} catch {
					interpretation = { events: [], analysis: failure("Jev interpretation failed") };
				}
				let outcome = await deps.exclusive(async () => {
					if (!active()) return "stopped" as const;
					let current = plan.conversationPlan;
					if (
						!current.queue.some(item =>
							item.messageId === interpretInput.message.id && item.status === "pending"
						)
					) return "gone" as const;
					let affected = new Set(interpretation.events.map(event => event.threadId));
					if (interpretation.researchOffer) affected.add(interpretation.researchOffer.threadId);
					if (
						plan.pendingCardActions.some(action =>
							affected.has(action.threadId)
							&& ["decided", "reopened", "discarded"].includes(action.kind)
						)
					) return "waiting" as const;
					if (!sameThreads(interpretInput.state, current)) return "stale" as const;
					let currentCards = linkedCardOptions(plan, current);
					if (
						[...affected].some(id =>
							!isDeepStrictEqual(interpretInput.linkedCards.get(id), currentCards.get(id))
						)
					) return "stale" as const;
					if (
						[...affected].some(id => {
							let thread = current.threads.find(item => item.id === id);
							return thread && !isDeepStrictEqual(cardCycles.get(id), cardCycle(plan, thread));
						})
					) return "stale" as const;
					let admittedEvents = interpretation.events.filter(event => {
						if (
							event.type !== "scoped-choice.proposed"
							&& event.type !== "scoped-choice.agreed"
						) return true;
						let thread = current.threads.find(item => item.id === event.threadId);
						let card = currentCards.get(event.threadId);
						return thread?.questionnaireId === event.cardId && card?.cardId === event.cardId
							&& card.options.filter(item =>
									item.id === event.optionId && item.label === event.label
								).length === 1
							&& (event.type !== "scoped-choice.agreed" || !!thread
									&& currentScopedProposal(thread, current.events)?.id === event.proposalId);
					});
					let next: State;
					try {
						next = completeAnalysis(
							current,
							interpretInput.message.id,
							admittedEvents,
							interpretInput.message,
							interpretation.analysis,
						);
						assertEventCapacity(next, plan.pendingCardActions.length);
						assertOptionCapacity({ ...plan, conversationPlan: next });
					} catch (error) {
						next = completeAnalysis(
							current,
							interpretInput.message.id,
							[],
							interpretInput.message,
							failure(
								error instanceof ConversationCapacityError
									? error.message
									: "analysis failed validation",
							),
						);
					}
					try {
						let researchThread = next.threads.find(item =>
							item.id === interpretation.researchOffer?.threadId
						);
						let cardId = researchThread?.questionnaireId;
						next = admitResearchOffer(
							current,
							next,
							interpretInput.message,
							interpretation.researchOffer,
							currentCards.get(researchThread?.id ?? ""),
							!!cardId && plan.records.has(cardId),
						);
					} catch {
						// A rejected optional offer must not discard valid planning events.
					}
					let pending = plan.conversationPlanPendingEffects;
					plan.conversationPlan = next;
					try {
						let record = next.analysis.find(item => item.messageId === interpretInput.message.id);
						let accepted = next.events.filter(event => record?.eventIds.includes(event.id));
						plan.conversationPlanPendingEffects = appendEffects(
							plan,
							effectsFor(accepted, next, record, plan.records),
						);
						await deps.persist();
						return "committed" as const;
					} catch (error) {
						plan.conversationPlan = current;
						plan.conversationPlanPendingEffects = pending;
						throw error;
					}
				});
				if (outcome === "stopped") return false;
				if (outcome === "waiting") return true;
				if (outcome === "stale") {
					if (++stale < 3) continue;
					let failed = await deps.exclusive(async () => {
						if (!active()) return false;
						let current = plan.conversationPlan;
						let message = plan.chat.entries.find(entry => entry.id === interpretInput.message.id);
						if (
							!message
							|| !current.queue.some(item =>
								item.messageId === interpretInput.message.id && item.status === "pending"
							)
						) return false;
						plan.conversationPlan = completeAnalysis(
							current,
							message.id,
							[],
							message,
							failure("analysis changed during inference; retry"),
						);
						try {
							await deps.persist();
							return true;
						} catch (error) {
							plan.conversationPlan = current;
							throw error;
						}
					});
					if (failed) publish();
					break;
				}
				if (outcome === "committed") {
					publish();
					await drainEffects();
				}
				break;
			}
		}
		return false;
	}
	return run;
}
