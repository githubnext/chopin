import { entry, harness } from "./service.test-fixtures";
import { applyResearchOpportunity } from "./research-opportunities";
import { researchContext } from "./research-interpreter";
import { createResearchDraftService } from "./research-draft-service";

export function researchDraftHarness() {
	let h = harness();
	let message = entry("research", "Investigate Jev alternatives.");
	h.plan.chat.entries.push(message);
	let input = { state: h.plan.conversationPlan, message, recent: [] };
	h.plan.conversationPlan = applyResearchOpportunity(h.plan.conversationPlan, h.plan.id, input, {
		analysis: {
			messageId: message.id,
			questionSetVersion: "research-test",
			modelVersion: "fixture",
			status: "unlinked",
			answers: {},
			policyGate: "",
			latencyMs: 1,
		},
		candidate: {
			source: {
				messageId: message.id,
				author: { kind: "member", handle: "ana" },
				quote: message.text,
				start: 0,
				end: message.text.length,
			},
			context: researchContext(input),
			explicit: true,
			changed: false,
			standalone: true,
		},
	});
	let drafts = createResearchDraftService(h.dependencies, () => true);
	return {
		...h,
		drafts,
		id: h.plan.conversationPlan.researchOffers![0]!.id,
		actor: { kind: "member" as const, handle: "ana" },
		offer: () => h.plan.conversationPlan.researchOffers![0]!,
	};
}
