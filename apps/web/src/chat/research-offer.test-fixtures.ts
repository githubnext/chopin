import { expect } from "bun:test";
import { ResearchOfferLinkObserver } from "./research-offer";
import type { ConversationPlan } from "@chopin/protocol";
import type { OfferLinkView } from "./research-offer";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, apps/web/src/chat/research-offer.test.ts.
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	let promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

export function fixture() {
	let reads: string[] = [];
	let replies: ReturnType<typeof deferred<ConversationPlan.ResearchLinkResult>>[] = [];
	let timers = new Map<number, { run: () => void; ms: number }>();
	let cancelled: number[] = [];
	let nextTimer = 0;
	let links: Readonly<Record<string, OfferLinkView>> = {};
	let observer = new ResearchOfferLinkObserver(
		id => {
			reads.push(id);
			let reply = deferred<ConversationPlan.ResearchLinkResult>();
			replies.push(reply);
			return reply.promise;
		},
		value => links = value,
		(run, ms) => {
			let id = ++nextTimer;
			timers.set(id, { run, ms });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		timer => {
			let id = timer as unknown as number;
			cancelled.push(id);
			timers.delete(id);
		},
	);
	let tick = (ms: number) => {
		let entry = [...timers].find(([, value]) => value.ms === ms);
		expect(entry).toBeDefined();
		timers.delete(entry![0]);
		entry![1].run();
	};
	return {
		observer,
		reads,
		replies,
		timers,
		cancelled,
		tick,
		get links() {
			return links;
		},
	};
}

export async function settle() {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

export function pending(offerId = "offer-1"): ConversationPlan.ResearchLinkResult {
	return { kind: "conversation-plan:research-link", offerId, status: "pending", ts: 1 };
}
