import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { type Effect, effectsFor, runEffects } from "./effects";
import { event, LATER, OPTION, sink, thread } from "./effects.test-fixtures";

// Whole callbacks from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.test.ts.
test("mirroring an existing linked card option skips add and job but keeps the prompt", () => {
	let source = {
		messageId: "m5",
		author: { kind: "member" as const, handle: "jules" },
		quote: "Let's just go with Auth0.",
		start: 0,
		end: 24,
		role: "option" as const,
	};
	let linked = {
		...initialState(),
		threads: [thread({
			questionnaireId: "Q",
			pendingSettle: { optionId: LATER, proposer: "jules", messageId: "m5" },
			contributions: [{
				id: LATER,
				kind: "option",
				text: "Auth0",
				authoring: "scribe",
				sources: [source],
				actor: { kind: "classifier" },
			}],
		})],
	};
	let added = event("option.added", "card-mirror", {
		source,
		contribution: { id: LATER, text: "Auth0", authoring: "scribe" },
	});
	let settle = event("settle.suggested", "card-settle", {
		source: { ...source, role: "resolution" },
		optionId: LATER,
	});
	let records = new Map([["Q", {
		history: [],
		definition: { questions: [{ options: [{ id: LATER }] }] },
	}]]);
	let effects = effectsFor([added, settle], linked, undefined, records);
	expect(effects.some(item => item.kind === "add-option" || item.kind === "job")).toBe(false);
	expect(effects.some(item => item.kind === "prompt")).toBe(true);
});

test("unlinked work defers, closed work is receipted, and absent job sink never spins", async () => {
	let state = sink({ target: () => ({ kind: "unlinked" }) });
	let option: Effect = {
		key: "option:2",
		kind: "add-option",
		threadId: "t1",
		optionId: LATER,
		label: "Auth0",
		trigger: "option-2",
	};
	let job: Effect = {
		key: "job:heading:document",
		kind: "job",
		intent: { kind: "heading", target: "document", trigger: "m1" },
	};
	expect(await runEffects(state.deps, [option, job])).toBe(0);
	expect(state.calls).toEqual([]);
	expect([...state.receipts]).toEqual([]);
	state.deps.target = () => ({ kind: "closed" });
	expect(await runEffects(state.deps, [option, job])).toBe(1);
	expect([...state.receipts]).toEqual(["option:2"]);
	state.deps.enqueueJob = async () => void state.calls.push("job");
	expect(await runEffects(state.deps, [option, job])).toBe(1);
	expect(state.calls).toEqual(["job"]);
});

test("a closed card accepts only its current saved prose generation", async () => {
	let calls: string[] = [];
	let state = sink({
		target: () => ({ kind: "closed" }),
		proseReady: (thread, id, trigger) => thread === "t1" && id === "Q" && trigger === "decided:Q:2",
		enqueueJob: async intent => void calls.push(intent.trigger),
	});
	let stale: Effect = {
		key: "job:prose:Q:1",
		kind: "job",
		threadId: "t1",
		intent: { kind: "prose", target: "Q", trigger: "decided:Q:1" },
	};
	let current: Effect = {
		key: "job:prose:Q:2",
		kind: "job",
		threadId: "t1",
		intent: { kind: "prose", target: "Q", trigger: "decided:Q:2" },
	};
	let mismatched: Effect = {
		...current,
		key: "job:prose:Q:2:wrong-thread",
		threadId: "t2",
	};
	expect(await runEffects(state.deps, [stale, mismatched, current])).toBe(3);
	expect(calls).toEqual(["decided:Q:2"]);
	expect(state.receipts).toEqual(new Set([stale.key, mismatched.key, current.key]));
	let reopened = sink({
		target: () => ({ kind: "open", id: "Q" }),
		proseReady: () => false,
		enqueueJob: async intent => void calls.push(intent.trigger),
	});
	expect(await runEffects(reopened.deps, [current])).toBe(1);
	expect(reopened.receipts).toEqual(new Set([current.key]));
	expect(calls).toEqual(["decided:Q:2"]);
	let malformedErrors: unknown[] = [];
	let malformed = sink({
		enqueueJob: async intent => void calls.push(intent.trigger),
		report: error => void malformedErrors.push(error),
	});
	expect(await runEffects(malformed.deps, [{ ...current, threadId: undefined }])).toBe(0);
	expect(malformed.calls).toEqual([]);
	expect(malformedErrors).toHaveLength(1);
});

test("a pending suggestion waits for a link and targets the linked card exactly once", async () => {
	let linked = false;
	let delivered: Array<{ card: string; optionId?: string; messageIds: string[] }> = [];
	let state = sink({
		target: () => linked ? { kind: "open", id: "Q" } : { kind: "unlinked" },
		suggest: async (card, input) => void delivered.push({ card, ...input }),
	});
	let suggestion: Effect = {
		key: "suggest:settle-1",
		kind: "suggest",
		threadId: "t1",
		optionId: OPTION,
		messageIds: ["m1"],
	};
	expect(await runEffects(state.deps, [suggestion])).toBe(0);
	expect(delivered).toEqual([]);
	linked = true;
	expect(await runEffects(state.deps, [suggestion])).toBe(1);
	expect(delivered).toEqual([{ card: "Q", optionId: OPTION, messageIds: ["m1"] }]);
	expect(await runEffects(state.deps, [suggestion])).toBe(0);
	expect(delivered).toHaveLength(1);
});

test("failed insert retains its key; retry links and receipts it", async () => {
	let attempts = 0;
	let state = sink({
		target: () => ({ kind: "unlinked" }),
		insertCard: async () => {
			if (attempts++ === 0) throw new Error("storage unavailable");
			state.calls.push("insert");
			return "Q";
		},
	});
	let insert: Effect = {
		key: "insert:t1",
		kind: "insert-card",
		threadId: "t1",
		header: "Auth",
		question: "Which auth system?",
		options: [],
		trigger: "open-1",
	};
	expect(await runEffects(state.deps, [insert])).toBe(0);
	expect([...state.receipts]).toEqual([]);
	expect(await runEffects(state.deps, [insert])).toBe(1);
	expect(state.calls).toEqual(["insert", "link"]);
	expect([...state.receipts]).toEqual(["insert:t1"]);
});

test("closed inserts are terminal without creating a card", async () => {
	let state = sink({ target: () => ({ kind: "closed" }) });
	let insert: Effect = {
		key: "insert:t1",
		kind: "insert-card",
		threadId: "t1",
		header: "Auth",
		question: "Which auth system?",
		options: [],
		trigger: "open-1",
	};
	expect(await runEffects(state.deps, [insert])).toBe(1);
	expect(state.calls).toEqual([]);
	expect([...state.receipts]).toEqual(["insert:t1"]);
});

test("a lost insert receipt recognizes the already-linked card on retry", async () => {
	let linked = false;
	let failReceipt = true;
	let state = sink({
		target: () => linked ? { kind: "open", id: "Q" } : { kind: "unlinked" },
		link: async () => {
			linked = true;
			state.calls.push("link");
		},
		markApplied: async key => {
			if (failReceipt) {
				failReceipt = false;
				throw new Error("receipt commit failed");
			}
			state.receipts.add(key);
		},
	});
	let insert: Effect = {
		key: "insert:t1",
		kind: "insert-card",
		threadId: "t1",
		header: "Auth",
		question: "Which auth system?",
		options: [],
		trigger: "open-1",
	};
	expect(await runEffects(state.deps, [insert])).toBe(0);
	expect(state.calls).toEqual(["insert", "link"]);
	expect(await runEffects(state.deps, [insert])).toBe(1);
	expect(state.calls).toEqual(["insert", "link"]);
	expect([...state.receipts]).toEqual(["insert:t1"]);
});
