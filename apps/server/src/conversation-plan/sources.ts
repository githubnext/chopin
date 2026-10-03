import type { Chat, ConversationPlan } from "@chopin/protocol";

const ROLES = new Set<ConversationPlan.SourceRole>([
	"question",
	"option",
	"reason",
	"constraint",
	"support",
	"objection",
	"withdrawal",
	"verification",
	"resolution",
	"reopening",
]);

export function assertSourceShape(value: unknown): asserts value is ConversationPlan.SourceRef {
	if (!value || typeof value !== "object") throw new Error("invalid conversation source");
	let source = value as Record<string, unknown>;
	if (
		Object.keys(source).some((key) =>
			![
				"messageId",
				"author",
				"quote",
				"start",
				"end",
				"role",
			].includes(key)
		)
	) throw new Error("unknown conversation source field");
	let author = source.author;
	if (
		typeof source.messageId !== "string" || !source.messageId || source.messageId.length > 200
		|| typeof source.quote !== "string" || !source.quote || source.quote.length > 2048
		|| !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end)
		|| (source.start as number) < 0 || (source.end as number) <= (source.start as number)
		|| (source.end as number) - (source.start as number) !== source.quote.length
		|| !ROLES.has(source.role as ConversationPlan.SourceRole)
		|| !author || typeof author !== "object"
	) throw new Error("invalid conversation source");
	let claimed = author as Record<string, unknown>;
	if (
		Object.keys(claimed).some((key) =>
			![
				"kind",
				...(claimed.kind === "member" ? ["handle"] : []),
			].includes(key)
		)
	) throw new Error("unknown conversation source author field");
	if (
		!((claimed.kind === "member" && typeof claimed.handle === "string" && claimed.handle.length > 0)
			|| claimed.kind === "agent")
	) throw new Error("invalid conversation source author");
}

/** Validates against the saved Chat entry, not candidate text supplied by the classifier. */
export function validateSource(source: ConversationPlan.SourceRef, message: Chat.Entry): void {
	assertSourceShape(source);
	if (
		message.id !== source.messageId
		|| message.streaming
		|| message.author.kind !== source.author.kind
		|| (message.author.kind === "member" && source.author.kind === "member"
			&& message.author.handle !== source.author.handle)
		|| message.text.slice(source.start, source.end) !== source.quote
	) throw new Error("conversation source quote does not match saved message");
}
