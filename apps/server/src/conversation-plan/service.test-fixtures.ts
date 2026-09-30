import { expect } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";

import type { Effect } from "./effects";
import type { PendingCardAction } from "../questions/card-actions";
import type { Dependencies } from "./service";

// Exact helpers from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
export type PlanData = Dependencies["plan"];

export function entry(id: string, text: string): Chat.Entry {
	return { id, text, ts: 1000, author: { kind: "member", handle: "ana" } };
}

export function opened(message: Chat.Entry): ConversationPlan.Event {
	return {
		id: `open:${message.id}`,
		threadId: "thread-a",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: message.ts,
		type: "thread.opened",
		source: {
			messageId: message.id,
			author: message.author as ConversationPlan.SourceAuthor,
			quote: message.text,
			start: 0,
			end: message.text.length,
			role: "question",
		},
		question: message.text,
	};
}

export function unlinked(): Awaited<ReturnType<NonNullable<Dependencies["interpret"]>>> {
	return {
		events: [],
		analysis: {
			questionSetVersion: "test",
			modelVersion: "fake",
			status: "unlinked",
			passes: [],
		},
	};
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let promise = new Promise<T>(done => resolve = done);
	return { promise, resolve };
}

export async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition did not become true");
}

export function harness(
	interpret: NonNullable<Dependencies["interpret"]> = async () => unlinked(),
) {
	let plan = {
		id: "channel",
		chat: { entries: [] as Chat.Entry[] },
		conversationPlan: initialState(),
		conversationPlanRetries: [] as Array<{ id: string; messageId: string }>,
		conversationPlanEffects: [] as string[],
		conversationPlanPendingEffects: [] as Effect[],
		pendingCardActions: [] as PendingCardAction[],
		records: new Map(),
	} as PlanData;
	let durable = structuredClone({
		entries: plan.chat.entries,
		state: plan.conversationPlan,
		retries: plan.conversationPlanRetries,
		receipts: plan.conversationPlanEffects,
		pending: plan.conversationPlanPendingEffects,
		pendingCards: plan.pendingCardActions,
		records: plan.records,
	});
	let publications: ConversationPlan.State[] = [];
	let active = true;
	let failNext = false;
	let locked = false;
	let tail = Promise.resolve();
	let errors: unknown[] = [];
	let dependencies: Dependencies = {
		plan,
		exclusive: action => {
			let operation = tail.then(async () => {
				locked = true;
				try {
					return await action();
				} finally {
					locked = false;
				}
			});
			tail = operation.then(() => {}, () => {});
			return operation;
		},
		persist: async () => {
			if (failNext) {
				failNext = false;
				throw new Error("storage failed");
			}
			durable = structuredClone({
				entries: plan.chat.entries,
				state: plan.conversationPlan,
				retries: plan.conversationPlanRetries,
				receipts: plan.conversationPlanEffects,
				pending: plan.conversationPlanPendingEffects,
				pendingCards: plan.pendingCardActions,
				records: plan.records,
			});
		},
		publish: state => {
			expect(durable.state).toEqual(state);
			publications.push(structuredClone(state));
		},
		active: () => active,
		interpret: async (input, signal) => {
			expect(locked).toBe(false);
			return interpret(input, signal);
		},
		onError: error => errors.push(error),
	};
	return {
		plan,
		dependencies,
		get durable() {
			return durable;
		},
		publications,
		errors,
		set active(value: boolean) {
			active = value;
		},
		fail() {
			failNext = true;
		},
	};
}
