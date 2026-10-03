import type { ConversationPlan } from "@chopin/protocol";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import type { MockMutation } from "./pipeline-ordinary-save.test-fixtures";

export function hostingState(): ConversationPlan.State {
	return stateWithOption(
		"Where should the app be hosted?",
		"hosting-thread",
		"vps-option",
		"Host the app on our own VPS.",
	);
}

export function lowConfidenceResolution(threadId: string, optionId: string): MockMutation {
	return (result, prefix) => {
		if (!prefix) return;
		Object.assign(result.answers[`${prefix}_role`], {
			confidence: 0.73,
			probabilities: { resolution: 0.76, option: 0.14, none: 0.1 },
		});
		Object.assign(result.answers[`${prefix}_chosen_option`], {
			choice: optionId,
			confidence: 0.87,
			probabilities: { [optionId]: 0.87, new: 0.08, none: 0.05 },
		});
		Object.assign(result.answers[`${prefix}_thread`], {
			confidence: 0.99,
			probabilities: { [threadId]: 0.99, none: 0.01 },
		});
	};
}
