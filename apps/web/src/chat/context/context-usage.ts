import type { Chat } from "@chopin/protocol";
import type { ComposerUsage } from "@/components/assistant-ui/elements/composer";
import type { ContextSegment } from "@/components/assistant-ui/elements/context-breakdown";

function roundThousands(tokens: number): number {
	if (!(tokens > 0)) return 0;
	return Math.round(tokens / 100) / 10;
}

/**
 * Convert Chopin's harness-reported `ContextUsage` into `ComposerContext`'s `ComposerUsage`
 * (whose values represent thousands, because upstream prints `{value}k` directly).
 * Returns `undefined` when no positive usage or window is reported.
 */
export function toComposerUsage(usage: Chat.ContextUsage | undefined): ComposerUsage | undefined {
	if (!usage || !(usage.contextWindow > 0) || !(usage.totalTokens > 0)) return undefined;
	let system = roundThousands(usage.system ?? 0);
	let tools = roundThousands(usage.tools ?? 0);
	let remainingTokens = Math.max(0, usage.totalTokens - (usage.system ?? 0) - (usage.tools ?? 0));
	let messages = roundThousands(remainingTokens);
	let total = Math.max(roundThousands(usage.contextWindow), 0.1);
	if (system + tools + messages <= 0) messages = 0.1;
	return { system, tools, messages, total };
}

/**
 * Convert Chopin's `ContextUsage` into `ContextBreakdown`'s raw-token segments using Chopin's
 * brand role tints (`bg-primary`, `bg-primary/65`, `bg-primary/35`).
 */
export function toBreakdownSegments(
	usage: Chat.ContextUsage | undefined,
): { segments: ContextSegment[]; limit: number } | undefined {
	if (!usage || !(usage.contextWindow > 0) || !(usage.totalTokens > 0)) return undefined;
	let segments: ContextSegment[] = [];
	if (usage.system && usage.system > 0) {
		segments.push({ label: "System prompt", tokens: usage.system, tint: "bg-primary/35" });
	}
	if (usage.tools && usage.tools > 0) {
		segments.push({ label: "Tools", tokens: usage.tools, tint: "bg-primary/55" });
	}
	let cached = usage.cachedTokens && usage.cachedTokens > 0 ? usage.cachedTokens : 0;
	let uncachedInput = Math.max(0, usage.inputTokens - cached);
	if (cached > 0) {
		segments.push({ label: "Cached input", tokens: cached, tint: "bg-primary/40" });
	}
	if (uncachedInput > 0) {
		segments.push({ label: "Input", tokens: uncachedInput, tint: "bg-primary/70" });
	}
	if (usage.outputTokens > 0) {
		segments.push({ label: "Output", tokens: usage.outputTokens, tint: "bg-primary" });
	}
	if (segments.length === 0) {
		segments.push({ label: "Conversation", tokens: usage.totalTokens, tint: "bg-primary" });
	}
	return { segments, limit: usage.contextWindow };
}
