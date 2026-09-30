import type { ConversationPlan } from "@chopin/protocol";
import { id, knownKeys, record, text, version } from "./validation-fields";

export function assertCorrectionChange(
	value: unknown,
): asserts value is ConversationPlan.CorrectionChange {
	let change = record(value);
	switch (change.kind) {
		case "add-excerpt":
			knownKeys(change, [
				"kind",
				"messageId",
				"start",
				"end",
				"contributionKind",
				"targetOptionId",
			]);
			id(change.messageId);
			if (
				!Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end)
				|| (change.start as number) < 0 || (change.end as number) <= (change.start as number)
				|| (change.end as number) - (change.start as number) > 500
			) throw new Error("invalid excerpt range");
			if (!["option", "reason", "constraint"].includes(change.contributionKind as string)) {
				throw new Error("invalid excerpt contribution kind");
			}
			if (change.targetOptionId !== undefined) id(change.targetOptionId);
			break;
		case "edit":
			knownKeys(change, ["kind", "field", "contributionId", "text"]);
			if (!["question", "contribution", "decision"].includes(change.field as string)) {
				throw new Error("invalid edit field");
			}
			text(change.text);
			if (change.field === "contribution") id(change.contributionId);
			else if ("contributionId" in change) {
				throw new Error("unexpected contribution ID on question or decision edit");
			}
			break;
		case "move":
			knownKeys(change, ["kind", "contributionId", "targetThreadId", "targetVersion"]);
			id(change.contributionId);
			id(change.targetThreadId);
			version(change.targetVersion);
			break;
		case "set-status":
			knownKeys(change, ["kind", "status"]);
			if (!["exploring", "leaning", "reopened"].includes(change.status as string)) {
				throw new Error("invalid status correction");
			}
			break;
		case "retarget-stance":
			knownKeys(change, ["kind", "stanceId", "optionId"]);
			id(change.stanceId);
			if (change.optionId !== undefined) id(change.optionId);
			break;
		case "dismiss-stance":
			knownKeys(change, ["kind", "stanceId"]);
			id(change.stanceId);
			break;
		case "retarget-contribution":
			knownKeys(change, ["kind", "contributionId", "targetId"]);
			id(change.contributionId);
			id(change.targetId);
			break;
		case "record-decision":
			knownKeys(change, ["kind", "text", "optionId"]);
			text(change.text);
			if (change.optionId !== undefined) id(change.optionId);
			break;
		case "confirm-candidate":
		case "reject-candidate":
			knownKeys(change, ["kind", "candidateId"]);
			id(change.candidateId);
			break;
		default:
			throw new Error("invalid correction action");
	}
}

export function assertCorrectionAction(
	value: unknown,
): asserts value is ConversationPlan.CorrectionAction {
	let action = record(value);
	knownKeys(action, ["actionId", "threadId", "expectedVersion", "change"]);
	id(action.actionId);
	id(action.threadId);
	version(action.expectedVersion);
	assertCorrectionChange(action.change);
}
