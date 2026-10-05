import { expect, test } from "bun:test";
import { postmarkId, sesId, stateWithOptions } from "./research-offers.test-fixtures";
import { interpretMessage } from "./interpret";
import { message, mockResult } from "./interpret.test-fixtures";

// Preserve original targeting dispatch turn; helper extraction must introduce no extra await.
test.each([false, true])(
	"research eligible %s retains targeting dispatch before the next queued observation",
	async eligible => {
		let targetingCalls = 0;
		let observe!: (count: number) => void;
		let observed = new Promise<number>(resolve => observe = resolve);
		let pending = interpretMessage({
			channelId: "channel",
			message: message("dispatch-order", "Should we use GitHub authentication?"),
			recent: [],
			state: stateWithOptions("auth", "Which authentication?", [
				{ id: postmarkId, label: "GitHub" },
				{ id: sesId, label: "Email" },
			]),
			ask: request => {
				let triage = "new_question" in request.questions;
				let research = "research_kind" in request.questions;
				if (triage || research) {
					queueMicrotask(() => queueMicrotask(() => observe(targetingCalls)));
				}
				if (!triage && !research) targetingCalls++;
				return Promise.resolve(
					mockResult(
						request.questions,
						triage ? { new_question: 0.95, research_need: eligible ? 0.95 : 0.05 } : {},
					),
				);
			},
		});
		expect(await observed).toBe(1);
		let output = await pending;
		expect(output.analysis.passes.map(pass => pass.stage)).toEqual(["triage", "targeting"]);
		expect(output.researchOffer).toBeUndefined();
	},
);
