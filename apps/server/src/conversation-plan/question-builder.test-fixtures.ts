import type { Chat, ConversationPlan } from "@chopin/protocol";
import { extractQuotes } from "./quotes";

// Exact archive data/helpers: 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/questions.test.ts.
export let text =
	"For human sign-in, the options are GitHub OAuth or email magic links. Separately, for the hosted agent’s repository credentials, we could pass each user’s GitHub token or use a GitHub App installation token. Those are two different calls.";
export let message: Chat.Entry = {
	id: "D19-m2",
	text,
	author: { kind: "member", handle: "Omar" },
	ts: 1_000,
};
export let quotes = extractQuotes(text);

export let fourCandidates = () => {
	let text = [
		"Use GitHub OAuth",
		"Use email magic links",
		"Use the GitHub App if it supports SSO",
		"Keep repository tokens separate",
	].join("; ");
	let candidates = [
		"Use GitHub OAuth",
		"Use email magic links",
		"Use the GitHub App if it supports SSO",
		"Keep repository tokens separate",
	].map(quote => {
		let start = text.indexOf(quote);
		return { quote, start, end: start + quote.length };
	});
	return {
		current: { ...message, id: "four-source-spans", text },
		candidates,
	};
};

export let threadWithStatus = (
	status: ConversationPlan.Thread["status"],
): ConversationPlan.Thread => ({
	id: "auth-thread",
	question: "How should people sign in?",
	questionSources: [],
	questionAuthoring: "quoted",
	status,
	contributions: [],
	stances: [],
	stanceHistory: [],
	decision: status === "decided"
		? {
			id: "decision",
			text: "Use GitHub OAuth",
			sources: [],
			actor: { kind: "member", handle: "Mina" },
			at: 1_000,
		}
		: undefined,
	decisionHistory: [],
	candidates: [],
	version: 1,
});

export let cacheText = "🧪 Use Redis for API caching; use Valkey for background jobs.";
export let cacheMessage: Chat.Entry = {
	id: "cache-options",
	text: cacheText,
	author: { kind: "member", handle: "Ari" },
	ts: 2_001,
};
export let cacheQuotes = extractQuotes(cacheText);
export let emptyCacheThread = {
	...threadWithStatus("exploring"),
	id: "api-cache",
	question: "How should we cache API responses?",
};
