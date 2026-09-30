import { expect, test } from "bun:test";
import { appendProseEffect, proseIntent, prosePrompt } from "./prose-job";
import { CARD, record } from "./prose-job.test-fixtures";

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
		existing: "The previous decision used Auth0.",
	});
	expect(prompt).toContain("[Background job: prose]");
	expect(prompt).toContain(`Decision card id: ${CARD}`);
	expect(prompt).toContain("GitHub Apps");
	expect(prompt).toContain("The previous decision used Auth0.");
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
			existing: "E".repeat(10000),
		}).length,
	).toBeLessThan(9000);
});
