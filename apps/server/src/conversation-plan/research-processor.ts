import type { ConversationPlan } from "@chopin/protocol";
import type { Dependencies, Member } from "./processor-types";
import { RESEARCH_QUESTION_SET, type ResearchInterpretation } from "./research-interpreter";
import { assertStateShape } from "./validation";
import { MAX_ANALYSIS } from "./validation-fields";
import { applyResearchOpportunity, researchTargetChanged } from "./research-opportunities";
import { RESEARCH_POLICY_VERSION } from "./research-admission";

export function createResearchProcessor(
	deps: Dependencies,
	active: () => boolean,
	signal: AbortSignal,
	publish: () => void,
) {
	let running: Promise<void> | undefined;
	let wakeAgain = false;
	async function run() {
		let stale = 0;
		while (active() && deps.researchInterpret) {
			let input = await deps.exclusive(async () => {
				let item = deps.plan.conversationPlan.research?.queue.find(item =>
					item.status === "pending"
				);
				if (!item) return;
				let index = deps.plan.chat.entries.findIndex(entry => entry.id === item.messageId);
				if (index < 0) throw new Error("research message missing");
				return structuredClone({
					message: deps.plan.chat.entries[index]!,
					recent: deps.plan.chat.entries.slice(0, index).slice(-12),
					state: deps.plan.conversationPlan,
				});
			});
			if (!input) return;
			let result: ResearchInterpretation;
			try {
				result = await deps.researchInterpret(input, signal);
			} catch {
				result = {
					analysis: {
						messageId: input.message.id,
						questionSetVersion: RESEARCH_QUESTION_SET,
						policyVersion: RESEARCH_POLICY_VERSION,
						modelVersion: "unavailable",
						answers: {},
						status: "failed",
						policyGate: "research classification failed",
						latencyMs: 0,
					},
				};
			}
			await deps.exclusive(async () => {
				if (!active()) return;
				let previous = deps.plan.conversationPlan;
				let research = previous.research!;
				if (
					!research.queue.some(item =>
						item.messageId === input.message.id && item.status === "pending"
					)
				) return;
				if (researchTargetChanged(previous, input, result)) {
					if (++stale < 3) return;
					result = {
						analysis: {
							...result.analysis,
							status: "failed",
							policyGate: "research context changed; retry",
						},
					};
				}
				let applied = previous;
				try {
					applied = applyResearchOpportunity(previous, deps.plan.id, input, result);
				} catch {
					result = {
						analysis: {
							...result.analysis,
							status: "failed",
							policyGate: "research offer failed validation",
						},
					};
				}
				let next: ConversationPlan.State = {
					...applied,
					revision: applied.revision + 1,
					research: {
						...research,
						queue: result.analysis.status === "failed"
							? research.queue.map(item =>
								item.messageId === input.message.id
									? { ...item, status: "failed", error: result.analysis.policyGate }
									: item
							)
							: research.queue.filter(item => item.messageId !== input.message.id),
						analysis: [
							...research.analysis.filter(item => item.messageId !== input.message.id),
							result.analysis,
						].slice(-MAX_ANALYSIS),
					},
				};
				assertStateShape(next);
				deps.plan.conversationPlan = next;
				try {
					await deps.persist();
				} catch (error) {
					deps.plan.conversationPlan = previous;
					throw error;
				}
				publish();
				stale = 0;
			});
			deps.researchChanged?.();
		}
	}
	function wake() {
		if (!active() || !deps.researchInterpret) return;
		if (running) {
			wakeAgain = true;
			return;
		}
		running = run().catch(error => deps.onError?.(error)).finally(() => {
			running = undefined;
			if (wakeAgain) {
				wakeAgain = false;
				wake();
			}
		});
	}
	async function retry(actionId: string, messageId: string, actor: Member) {
		let queued = await deps.exclusive(async () => {
			if (!active() || !deps.researchInterpret) throw new Error("research analysis is unavailable");
			if (!/^[A-Za-z0-9._:-]{1,128}$/.test(actionId) || !messageId || messageId.length > 200) {
				throw new Error("invalid research retry");
			}
			let previous = deps.plan.conversationPlan;
			let state = previous.research!;
			let id = `human:${actor.handle}:${actionId}`;
			let receipt = state.retries.find(item => item.id === id);
			if (receipt) {
				if (receipt.messageId !== messageId) throw new Error("research retry ID collision");
				return state.queue.some(item => item.messageId === messageId && item.status === "pending");
			}
			if (state.retries.length >= 4096) throw new Error("research retry history is full");
			if (!state.queue.some(item => item.messageId === messageId && item.status === "failed")) {
				throw new Error("research message is not failed");
			}
			deps.plan.conversationPlan = {
				...previous,
				revision: previous.revision + 1,
				research: {
					...state,
					retries: [...state.retries, { id, messageId }],
					queue: state.queue.map(item =>
						item.messageId === messageId
							? { messageId, attempts: item.attempts + 1, status: "pending" }
							: item
					),
				},
			};
			try {
				await deps.persist();
			} catch (error) {
				deps.plan.conversationPlan = previous;
				throw error;
			}
			return true;
		});
		publish();
		wake();
		return { messageId, queued };
	}
	return {
		wake,
		retry,
		async idle() {
			let pending = running;
			while (pending) {
				await pending;
				pending = running;
			}
		},
	};
}
