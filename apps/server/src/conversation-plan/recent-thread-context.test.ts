import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";
import { applyEvent } from "./events";
import {
	buildCandidateTargetingRequest,
	buildTargetingRequest,
	buildTriageRequest,
} from "./questions";
import { visibleThreads } from "./question-context";
import { researchRequest } from "./research-interpreter";
import { message } from "./policy-initial.test-fixtures";
import { extractQuotes } from "./quotes";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import type { JevRequest } from "./jev";

function populated(count = 20): ConversationPlan.State {
	let state = initialState();
	for (let index = 0; index < count; index++) {
		let threadId = `thread-${index}`;
		let quote = `Which provider for service ${index}?`;
		let base = {
			threadId,
			origin: "classifier" as const,
			actor: { kind: "classifier" } as const,
			at: index + 1,
		};
		let source = {
			messageId: `message-${index}`,
			author: { kind: "member", handle: "alice" } as const,
			quote,
			start: 0,
			end: quote.length,
			role: "question" as const,
		};
		state = applyEvent(state, {
			...base,
			id: `opened-${index}`,
			type: "thread.opened",
			observedThreadVersion: 0,
			question: quote,
			source,
		});
		for (let option = 0; option < 2; option++) {
			let text = `Provider ${index}-${option}`;
			state = applyEvent(state, {
				...base,
				id: `added-${index}-${option}`,
				type: "option.added",
				observedThreadVersion: option + 1,
				contribution: { id: `option-${index}-${option}`, text, authoring: "quoted" },
				source: { ...source, quote: text, end: text.length, role: "option" },
			});
		}
	}
	return state;
}

function ids(selected: ReturnType<typeof visibleThreads>): string[] {
	return selected.map(({ thread }) => thread.id);
}

test("a twentieth thread enters the bounded context while small contexts retain their order", () => {
	let state = populated();
	let expected = state.threads.slice(-12).map(thread => thread.id);
	expect(ids(visibleThreads(state.threads))).toEqual(expected);
	expect(ids(visibleThreads(state.threads, state.events))).toEqual(expected);
	let small = state.threads.slice(0, 12);
	expect(ids(visibleThreads(small, state.events))).toEqual(small.map(thread => thread.id));
});

test("accepted corrections refresh old threads by event order across every request builder", () => {
	let state = populated();
	state = applyEvent(state, {
		id: "latest-correction",
		type: "card.corrected",
		threadId: "thread-0",
		observedThreadVersion: 3,
		origin: "human",
		actor: { kind: "member", handle: "alice" },
		at: 0,
		change: { kind: "edit", field: "question", text: "Which current provider for service 0?" },
	});
	let expected = ["thread-0", ...state.threads.slice(-11).map(thread => thread.id)];
	let current = message("current", "We need current provider costs.");
	let candidates = extractQuotes(current.text);
	let requests = [
		buildTriageRequest(current, [], state.threads, candidates, state.events),
		buildTargetingRequest(current, [], state.threads, candidates, undefined, state.events),
		buildCandidateTargetingRequest(current, [], state.threads, candidates, 0, state.events),
	];
	expect(
		researchRequest({ message: current, recent: [], state }).context.decisions.map(item => item.id),
	).toEqual(expected);
	for (let request of requests) {
		let context = request.state as { threads: Array<{ id: string; options: unknown[] }> };
		expect(context.threads.map(thread => thread.id)).toEqual(expected);
		expect(context.threads).toHaveLength(12);
		expect(context.threads.flatMap(thread => thread.options).length).toBeLessThanOrEqual(32);
		expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(23_500);
	}
});

test("a move refreshes both affected threads without promoting discarded threads over live ones", () => {
	let state = populated();
	state = applyEvent(state, {
		id: "move",
		type: "card.corrected",
		threadId: "thread-0",
		observedThreadVersion: 3,
		origin: "human",
		actor: { kind: "member", handle: "alice" },
		at: 21,
		change: {
			kind: "move",
			contributionId: "option-0-0",
			targetThreadId: "thread-1",
			targetVersion: 3,
		},
	});
	expect(ids(visibleThreads(state.threads, state.events))).toEqual([
		"thread-0",
		"thread-1",
		...state.threads.slice(-10).map(thread => thread.id),
	]);
	state = applyEvent(state, {
		id: "discard",
		type: "thread.discarded",
		threadId: "thread-19",
		observedThreadVersion: 3,
		origin: "human",
		actor: { kind: "member", handle: "alice" },
		at: 22,
	});
	expect(ids(visibleThreads(state.threads, state.events))).not.toContain("thread-19");
});

test("production decision interpretation supplies the accepted recency to targeting", async () => {
	let state = populated();
	state = applyEvent(state, {
		id: "newest-touch",
		type: "card.corrected",
		threadId: "thread-0",
		observedThreadVersion: 3,
		origin: "human",
		actor: { kind: "member", handle: "alice" },
		at: 0,
		change: { kind: "edit", field: "question", text: "Which current provider for service 0?" },
	});
	let requests: JevRequest[] = [];
	await interpretMessage({
		channelId: "channel",
		message: message("current", "We need current provider costs."),
		recent: [],
		state,
		ask: async request => {
			requests.push(request);
			return mockResult(request.questions, { research_need: 0.95, reason: 0.8 });
		},
	});
	expect(requests).toHaveLength(2);
	for (let request of requests) {
		let context = request.state as { threads: Array<{ id: string }> };
		expect(context.threads.map(thread => thread.id)).toEqual([
			"thread-0",
			...state.threads.slice(-11).map(thread => thread.id),
		]);
	}
});
