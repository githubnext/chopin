import { expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";
import {
	cacheMessage,
	cacheQuotes,
	cacheText,
	emptyCacheThread,
} from "./question-builder.test-fixtures";

// Original callbacks: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, questions.test.ts.
// Final parameterized interpreter callback (two cases) awaits the interpreter/policy slice.

test("a sibling span and preceding text are not prior duplicate evidence", () => {
	expect(cacheQuotes).toEqual([
		{ quote: "🧪 Use Redis for API caching;", start: 0, end: 29 },
		{ quote: "use Valkey for background jobs.", start: 30, end: 61 },
	]);
	let request = buildCandidateTargetingRequest(
		cacheMessage,
		[cacheMessage],
		[emptyCacheThread],
		cacheQuotes,
		1,
	);
	let state = request.state as {
		current: { text: string };
		preceding: string;
		candidates: typeof cacheQuotes;
		priorContributions: unknown[];
	};
	expect(request.questions.c1_duplicate).toBeUndefined();
	expect(state.priorContributions).toEqual([]);
	expect(state.current.text).toBe(cacheQuotes[1]!.quote);
	expect(state.preceding).toBe(cacheText.slice(0, cacheQuotes[1]!.start));
	expect(state.candidates).toEqual(cacheQuotes);
	expect(request.questions.c1_role?.type).toBe("choice");
	expect(request.questions.c1_role?.instructions).toContain("reported agreement");
	expect(request.questions.c1_thread?.type).toBe("choice");
	expect(request.questions.c1_explicit_resolution?.type).toBe("noul");
	expect(
		buildTriageRequest(cacheMessage, [], [emptyCacheThread], cacheQuotes).questions
			.c1_owned_unretracted?.type,
	).toBe("noul");
});

test("an accepted earlier message supplies a named prior-only duplicate comparator", () => {
	let earlier: Chat.Entry = {
		id: "cache-earlier-proposal",
		text: cacheQuotes[0]!.quote,
		author: { kind: "member", handle: "Mina" },
		ts: 2_000,
	};
	let accepted = {
		...emptyCacheThread,
		contributions: [{
			id: "cache-earlier-contribution",
			kind: "option" as const,
			text: earlier.text,
			authoring: "quoted" as const,
			sources: [{
				messageId: earlier.id,
				author: { kind: "member" as const, handle: "Mina" },
				quote: earlier.text,
				start: 0,
				end: earlier.text.length,
				role: "option" as const,
			}],
			actor: { kind: "classifier" as const },
		}],
	};
	let request = buildCandidateTargetingRequest(
		cacheMessage,
		[earlier, cacheMessage],
		[accepted],
		cacheQuotes,
		0,
	);
	let prior = (request.state as {
		priorContributions: Array<{ id: string; text: string }>;
	}).priorContributions;
	expect(request.questions.c0_duplicate?.type).toBe("noul");
	expect(prior).toEqual([expect.objectContaining({
		id: "cache-earlier-contribution",
		text: earlier.text,
	})]);
	expect(prior.every(item => item.text.length <= 300)).toBe(true);
	expect(prior.some(item => item.id === cacheMessage.id)).toBe(false);
});

test("retrying an older message excludes later accepted contributions", () => {
	let later: Chat.Entry = {
		...cacheMessage,
		id: "later-cache-proposal",
		text: cacheQuotes[0]!.quote,
		ts: cacheMessage.ts + 1,
	};
	let thread = {
		...emptyCacheThread,
		contributions: [{
			id: "later-cache-contribution",
			kind: "option" as const,
			text: later.text,
			authoring: "quoted" as const,
			sources: [{
				messageId: later.id,
				author: { kind: "member" as const, handle: "Ari" },
				quote: later.text,
				start: 0,
				end: later.text.length,
				role: "option" as const,
			}],
			actor: { kind: "classifier" as const },
		}],
	};
	let request = buildCandidateTargetingRequest(
		cacheMessage,
		[later],
		[thread],
		cacheQuotes,
		0,
	);
	expect((request.state as { priorContributions: unknown[] }).priorContributions).toEqual([]);
	expect(request.questions.c0_duplicate).toBeUndefined();
});

test("reported earlier context without an accepted contribution is not duplicate evidence", () => {
	let reported: Chat.Entry = {
		...cacheMessage,
		id: "reported-cache-proposal",
		text: `Mina said “${cacheQuotes[0]!.quote}” yesterday, but I disagree.`,
		ts: cacheMessage.ts - 1,
	};
	let request = buildCandidateTargetingRequest(
		cacheMessage,
		[reported],
		[emptyCacheThread],
		cacheQuotes,
		0,
	);
	expect((request.state as { priorContributions: unknown[] }).priorContributions).toEqual([]);
	expect(request.questions.c0_duplicate).toBeUndefined();
});

test("a source-free persisted contribution cannot prove it predates a retry", () => {
	let thread: ConversationPlan.Thread = {
		...emptyCacheThread,
		contributions: [{
			id: "cache-redis-option",
			kind: "option",
			text: cacheQuotes[0]!.quote,
			authoring: "quoted",
			sources: [],
			actor: { kind: "classifier" },
		}],
	};
	let request = buildCandidateTargetingRequest(cacheMessage, [], [thread], cacheQuotes, 0);
	let prior = (request.state as {
		priorContributions: Array<{ id: string; text: string }>;
	}).priorContributions;
	expect(request.questions.c0_duplicate).toBeUndefined();
	expect(prior).toEqual([]);
});
