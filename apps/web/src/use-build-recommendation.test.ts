import { expect, test } from "bun:test";

import { RecommendationReader } from "./use-build-recommendation";

import type { RecommendationSnapshot } from "@chopin/protocol/recommendation";
import type { ReadyRecommendation } from "./use-build-recommendation";

function ready(key: string): ReadyRecommendation {
	return {
		state: "ready",
		key,
		planRevision: 1,
		recommendation: {
			kind: "build",
			title: "Name open decisions clearly",
			scope: "Add a status label to the decision card.",
			reasons: ["The existing card supports open decisions."],
			dependencies: [],
			optional: ["Broader onboarding can stay open."],
			evidenceIds: [],
			nextAction: "Discuss the status label for open decisions.",
		},
		evidence: [],
	};
}

function harness() {
	let listeners = new Map<string, Set<(frame: unknown) => void>>();
	let wire = {
		on<T>(kind: string, listener: (frame: T) => void) {
			let callbacks = listeners.get(kind) ?? new Set();
			listeners.set(kind, callbacks);
			let callback = (frame: unknown) => listener(frame as T);
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
	};
	let reads: Array<{
		signal: AbortSignal;
		result: ReturnType<typeof Promise.withResolvers<RecommendationSnapshot>>;
	}> = [];
	let nextRead = Promise.withResolvers<void>();
	let reader = new RecommendationReader(signal => {
		let result = Promise.withResolvers<RecommendationSnapshot>();
		reads.push({ signal, result });
		nextRead.resolve();
		return result.promise;
	}, 0);
	return {
		reader,
		reads,
		connect: () => reader.connect(wire),
		emit: (kind: string) => {
			for (let callback of listeners.get(kind) ?? []) callback({});
		},
		started: async () => {
			await nextRead.promise;
			nextRead = Promise.withResolvers<void>();
		},
	};
}

test("a context change immediately hides advice and ignores an obsolete read", async () => {
	let fixture = harness();
	let disconnect = fixture.connect();
	await fixture.started();
	fixture.reads[0]!.result.resolve(ready("first"));
	await Promise.resolve();
	expect(fixture.reader.snapshot()?.key).toBe("first");
	fixture.emit("chat:message");
	expect(fixture.reader.snapshot()).toBeUndefined();
	expect(fixture.reads[0]!.signal.aborted).toBe(true);
	await fixture.started();
	fixture.emit("plan:ack");
	await fixture.started();
	fixture.reads[2]!.result.resolve(ready("changed-direction"));
	await Promise.resolve();
	fixture.reads[1]!.result.resolve(ready("obsolete"));
	await Promise.resolve();
	expect(fixture.reader.snapshot()?.key).toBe("changed-direction");
	disconnect();
});

test("bursts coalesce and pending, failed or quiet assessments wait for a real invalidation", async () => {
	let fixture = harness();
	let disconnect = fixture.connect();
	fixture.emit("plan:open");
	fixture.emit("question:resolved");
	fixture.emit("experiment:changed");
	fixture.emit("research:changed");
	await fixture.started();
	expect(fixture.reads).toHaveLength(1);
	fixture.reads[0]!.result.resolve({ state: "pending", key: "context" });
	await Bun.sleep(10);
	expect(fixture.reader.snapshot()).toBeUndefined();
	expect(fixture.reads).toHaveLength(1);
	fixture.emit("recommendation:changed");
	await fixture.started();
	fixture.reads[1]!.result.resolve({ state: "failed", key: "context" });
	await Bun.sleep(10);
	expect(fixture.reads).toHaveLength(2);
	expect(fixture.reader.snapshot()).toBeUndefined();
	fixture.emit("recommendation:changed");
	await fixture.started();
	fixture.reads[2]!.result.resolve({ state: "quiet", key: "paused-context" });
	await Bun.sleep(10);
	expect(fixture.reads).toHaveLength(3);
	expect(fixture.reader.snapshot()).toBeUndefined();
	disconnect();
});

test("disconnect cancels reads and listeners; reconnect reads fresh advice", async () => {
	let fixture = harness();
	let disconnect = fixture.connect();
	await fixture.started();
	disconnect();
	expect(fixture.reads[0]!.signal.aborted).toBe(true);
	fixture.reads[0]!.result.resolve(ready("offline"));
	await Promise.resolve();
	expect(fixture.reader.snapshot()).toBeUndefined();
	fixture.emit("recommendation:changed");
	await Bun.sleep(10);
	expect(fixture.reads).toHaveLength(1);
	disconnect = fixture.connect();
	await fixture.started();
	fixture.reads[1]!.result.resolve(ready("reconnected"));
	await Promise.resolve();
	expect(fixture.reader.snapshot()?.key).toBe("reconnected");
	disconnect();
});
