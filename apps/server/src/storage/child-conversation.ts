/**
 * A child document has no Chat: its root's Chat is the only one. This clears the
 * conversation a child accumulated before that was true. Storage-local and pure,
 * so both adapters apply the same rule.
 */
import type { JsonValue } from "./model";

/** Optional in a restored sidecar; `transcript` is required and is emptied instead. */
const CONVERSATION_FIELDS = [
	"workflowRuns",
	"conversationPlan",
	"conversationPlanRetries",
	"conversationPlanJobs",
	"conversationPlanEffects",
	"conversationPlanPendingEffects",
	"pendingCardActions",
];

type JsonObject = Record<string, JsonValue>;

function object(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function parsed(sidecar: unknown): unknown {
	if (typeof sidecar !== "string") return sidecar;
	try {
		return JSON.parse(sidecar);
	} catch {
		return undefined;
	}
}

/** Restoration rejects an option source whose message is gone, so such a record pins its Chat. */
function citesChat(record: JsonValue): boolean {
	let value = object(record);
	if (!value) return false;
	if (typeof value.threadId === "string") return true;
	let origins = object(value.optionOrigins);
	return !!origins && Object.values(origins).some(origin => !!object(origin)?.source);
}

export function childSidecarWithoutConversation(
	sidecar: unknown,
): JsonValue | "unchanged" | "kept" {
	let item = object(parsed(sidecar));
	if (!item) return "unchanged";
	let transcript = Array.isArray(item.transcript) ? item.transcript : [];
	let present = CONVERSATION_FIELDS.filter(field => Object.hasOwn(item, field));
	if (transcript.length === 0 && present.length === 0) return "unchanged";
	if (Array.isArray(item.questions) && item.questions.some(citesChat)) return "kept";
	let next: JsonObject = { ...item, transcript: [] };
	for (let field of present) delete next[field];
	return next;
}
