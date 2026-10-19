import { expect, test } from "bun:test";
import {
	appendProseEffect,
	proseInput,
	proseIntent,
	prosePrompt,
	whyIntent,
	whyPrompt,
	writeup,
} from "./prose-job";
import { CARD, OPTION, QUESTION, record } from "./prose-job.test-fixtures";

test("proseIntent uses the immutable Save generation, even for same-second re-decisions", () => {
	expect(proseIntent(record())).toEqual({
		kind: "prose",
		target: CARD,
		trigger: `decided:${CARD}:1`,
	});
	expect(proseIntent(record({ history: [{ choices: [], owner: "mina", at: 1_758_645_000 }] })))
		.toMatchObject({ trigger: `decided:${CARD}:2` });
	expect(proseIntent(record({ status: "reopened" }))).toBeUndefined();
	expect(proseIntent(record({ origin: "planner" }))).toBeUndefined();
	expect(proseIntent(record({ owner: undefined }))).toBeUndefined();
});

test("appendProseEffect is bounded and idempotent for one saved generation", () => {
	let first = appendProseEffect([], [], record());
	expect(first).toMatchObject([{
		key: `job:prose:${CARD}:1`,
		kind: "job",
		threadId: "thread-a",
		intent: { kind: "prose", target: CARD, trigger: `decided:${CARD}:1` },
	}]);
	expect(appendProseEffect(first, [], record())).toEqual(first);
	expect(appendProseEffect([], [first[0]!.key], record())).toEqual([]);
	expect(() =>
		appendProseEffect(
			Array.from({ length: 1024 }, (_, index) => ({
				key: `dummy:${index}`,
				kind: "job",
				intent: { kind: "heading", target: "document", trigger: `m${index}` },
			})),
			[],
			record(),
		)
	).toThrow(/outbox is full/);
});

test("prosePrompt stays bounded, grounded, and names only its own writing tool", () => {
	let prompt = prosePrompt({
		id: CARD,
		question: "Which authentication approach?",
		chosen: ["GitHub Apps"],
		owner: "mina",
		involved: ["mina", "jules"],
		reasons: ["We need an organisation-level sign-in flow."],
		findings: ["Apps scale per installation: rate limits apply per org"],
	});
	expect(prompt).toContain("[Background job: prose]");
	expect(prompt).toContain("What exploring the decision found:");
	expect(prompt).toContain("rate limits apply per org");
	expect(prompt).toContain(`Decision card id: ${CARD}`);
	expect(prompt).toContain("GitHub Apps");
	expect(prompt).toContain("replacement");
	expect(prompt).toContain("not evidence for this choice");
	expect(prompt).toContain("organisation-level sign-in flow");
	expect(prompt).toMatch(/do not add commitments/i);
	expect(prompt).toContain("write_decision_prose");
	expect(prompt).toContain("Use no other writing tool.");
	expect(prompt).not.toContain("making it a GitHub app");
	expect(
		prosePrompt({
			id: CARD,
			question: "Q".repeat(1000),
			chosen: Array.from({ length: 30 }, () => "L".repeat(300)),
			owner: "O".repeat(1000),
			involved: Array.from({ length: 30 }, () => "I".repeat(300)),
			reasons: Array.from({ length: 30 }, () => "R".repeat(1000)),
			findings: Array.from({ length: 30 }, () => "F".repeat(1000)),
		}).length,
	).toBeLessThan(12000);
});

test("prosePrompt lists the criteria marks of the chosen option, bounded", () => {
	let prompt = prosePrompt({
		id: CARD,
		question: "How do we sign in?",
		chosen: ["Passkeys"],
		owner: "mina",
		involved: ["mina"],
		reasons: [],
		criteria: ["New device: yes", "Easy reset: partly", "No new storage: not marked"],
	});
	expect(prompt).toContain("Criteria the chosen option was marked against");
	expect(prompt).toContain("- New device: yes");
	expect(prompt).toContain("- No new storage: not marked");
	expect(
		prosePrompt({ id: CARD, question: "Q", chosen: ["A"], owner: "m", involved: [], reasons: [] }),
	)
		.not.toContain("Criteria");
	expect(
		prosePrompt({
			id: CARD,
			question: "Q",
			chosen: ["A"],
			owner: "m",
			involved: [],
			reasons: [],
			criteria: Array.from({ length: 30 }, () => "C".repeat(500)),
		}).length,
	).toBeLessThan(3000);
});

test("proseInput carries the criteria and the chosen option's marks from the record", () => {
	let plan = {
		records: new Map([[
			CARD,
			record({
				definition: {
					questions: [{
						id: QUESTION,
						header: "Auth",
						question: "How do we sign in?",
						multiple: false,
						options: [{ id: OPTION, label: "Passkeys", description: "" }],
						criteria: [{ id: "c1", label: "New device" }, { id: "c2", label: "Easy reset" }],
					}],
				},
				choices: [OPTION],
				marks: { [`${OPTION}/c1`]: "yes", "other/c2": "no" },
			}),
		]]),
		conversationPlan: { threads: [], events: [] },
		conversationPlanJobs: [],
		conversationPlanPendingEffects: [],
		questions: { open: new Map(), closed: new Map() },
	};
	expect(() => proseInput(plan as never, CARD)).not.toThrow(/saved/);
	expect(proseInput(plan as never, CARD).criteria).toEqual([
		"New device: yes",
		"Easy reset: not marked",
	]);
});

test("writeup projects only the current saved generation's unfinished prose job", () => {
	let id = `prose:${CARD}:decided:${CARD}:1`;
	let job = (status: string, trigger = `decided:${CARD}:1`) => ({
		id: `prose:${CARD}:${trigger}`,
		kind: "prose" as const,
		target: CARD,
		trigger,
		status: status as never,
		attempts: 0,
		at: "2026-10-07T00:00:00.000Z",
	});
	let plan = (jobs: ReturnType<typeof job>[], pending = [] as never[]) => ({
		conversationPlanJobs: jobs,
		conversationPlanPendingEffects: pending,
	});

	expect(writeup(plan([]), record())).toBeUndefined();
	expect(writeup(plan([], appendProseEffect([], [], record()) as never[]), record()))
		.toEqual({ status: "writing", job: id });
	expect(writeup(plan([job("pending")]), record())).toEqual({ status: "writing", job: id });
	expect(writeup(plan([job("running")]), record())).toEqual({ status: "writing", job: id });
	expect(writeup(plan([job("failed")]), record())).toEqual({ status: "failed", job: id });
	expect(writeup(plan([job("done")]), record())).toBeUndefined();
	expect(writeup(plan([job("skipped")]), record())).toBeUndefined();
	// An earlier generation's failure does not describe a later save.
	expect(writeup(plan([job("failed", `decided:${CARD}:0`)]), record())).toBeUndefined();
	expect(writeup(plan([job("failed")]), record({ status: "reopened" }))).toBeUndefined();
	expect(writeup(plan([job("failed")]), record({ origin: "planner" }))).toBeUndefined();
});

test("a conversation decision's write-up is unchanged and keeps its thread", () => {
	let effects = appendProseEffect([], [], record());
	expect(effects).toHaveLength(1);
	expect(effects[0]).toMatchObject({
		threadId: "thread-a",
		intent: { trigger: `decided:${CARD}:1` },
	});
	expect(whyIntent(record())).toBeUndefined();
});

test("a planner or human decision enqueues one why-only draft per saved generation", () => {
	for (let origin of ["planner", "human"]) {
		let saved = record({ origin, threadId: undefined });
		expect(proseIntent(saved)).toBeUndefined();
		expect(whyIntent(saved)).toEqual({ kind: "prose", target: CARD, trigger: `why:${CARD}:1` });
		let first = appendProseEffect([], [], saved);
		expect(first).toEqual([{
			key: `job:why:${CARD}:1`,
			kind: "job",
			intent: { kind: "prose", target: CARD, trigger: `why:${CARD}:1` },
		}]);
		// Saving again, or replaying after the effect was applied, adds nothing.
		expect(appendProseEffect(first, [], saved)).toEqual(first);
		expect(appendProseEffect([], [first[0]!.key], saved)).toEqual([]);
		let again = record({
			origin,
			threadId: undefined,
			history: [{ choices: [], owner: "mina", at: 1_758_645_000 }],
		});
		expect(appendProseEffect(first, [], again)).toMatchObject([
			{ key: `job:why:${CARD}:1` },
			{ key: `job:why:${CARD}:2` },
		]);
	}
	expect(whyIntent(record({ origin: "human", status: "reopened" }))).toBeUndefined();
	expect(whyIntent(record({ origin: "human", owner: undefined }))).toBeUndefined();
	expect(appendProseEffect([], [], record({ origin: "human", status: "open" }))).toEqual([]);
});

test("the why-only prompt asks for no paragraph and lists the findings and takes", () => {
	let text = whyPrompt({
		id: CARD,
		question: "Where should it live?",
		chosen: ["In the account"],
		owner: "mina",
		involved: ["mina"],
		reasons: [],
		research: ["Docs: the account store is shared"],
		takes: ["supports: It is simplest"],
	});
	expect(text).toContain("Write no paragraph");
	expect(text).toContain("Question: Where should it live?");
	expect(text).toContain("Chosen: In the account");
	expect(text).toContain("- Docs: the account store is shared");
	expect(text).toContain("- supports: It is simplest");
	expect(text).toContain("at most 300 characters");
});
