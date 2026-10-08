import { afterEach, expect, test } from "bun:test";
import { currentDecision, decisionReplyCurrent, releaseDecision } from "./decision-pin";
import { ownedPoint, resolvedKeys } from "./resolved";
import { DECIDED, META } from "./widgets/questionnaire-metadata.test-fixtures";

afterEach(() => releaseDecision());

test("a metadata prose target joins current markers only after a durable decision", () => {
	let question = DECIDED.questions[0]!;
	expect(resolvedKeys(question, [], "prose", { ...META, hasProse: true })).toEqual(["prose"]);
	for (let status of ["open", "reopened", "discarded"] as const) {
		expect(resolvedKeys(question, ["old-linked"], "prose", { ...META, status, hasProse: true }))
			.toEqual([]);
	}
	expect(resolvedKeys({ ...question, answer: undefined }, [], "prose", { ...META, hasProse: true }))
		.toEqual([]);
});

test("saved decision prose takes precedence over a later unrelated question link", () => {
	let question = DECIDED.questions[0]!;
	let saved = { ...META, hasProse: true };
	expect(resolvedKeys(question, ["checklist"], "monitoring-prose", saved))
		.toEqual(["monitoring-prose"]);
	expect(resolvedKeys(question, ["checklist"], "alert-prose", saved))
		.toEqual(["alert-prose"]);
});

test("legacy per-question links remain exact and orphaned prose never guesses", () => {
	let question = DECIDED.questions[0]!;
	expect(resolvedKeys(question, ["first", "second"], "other", META)).toEqual(["first", "second"]);
	expect(resolvedKeys(question, ["legacy"], undefined)).toEqual(["legacy"]);
	expect(resolvedKeys(question, [], "old", { ...META, hasProse: true, proseOrphaned: true }))
		.toEqual([]);
	expect(resolvedKeys(question, [], undefined, { ...META, hasProse: true })).toEqual([]);
});

test("the current pointer adapter transfers a pin between surfaces and rejects stale replies", () => {
	let parent = {};
	let child = {};
	let state = ownedPoint(parent, {}, { type: "toggle", key: "parent/q" });
	expect(currentDecision()).toEqual({ owner: parent, id: "parent/q" });
	ownedPoint(child, {}, { type: "toggle", key: "child/q" });
	expect(decisionReplyCurrent(parent, "parent/q", 1, 1)).toBe(false);
	ownedPoint(parent, state, { type: "dismiss" });
	expect(currentDecision()).toEqual({ owner: child, id: "child/q" });
	expect(decisionReplyCurrent(child, "child/q", 1, 2)).toBe(false);
	ownedPoint(child, { pinned: "child/q" }, { type: "prune", live: new Set() });
	expect(currentDecision()).toBeUndefined();
});
