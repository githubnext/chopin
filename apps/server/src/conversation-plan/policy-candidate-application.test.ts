import { expect, test } from "bun:test";
import { applyCandidateEvent } from "./policy-candidate-application";
import {
	applicationFrame,
	batchEvents,
	supportInput,
} from "./policy-candidate-application.test-fixtures";
import { replay } from "./domain";
import { decidedInput, rawChoice } from "./policy-candidate-stance.test-fixtures";

// Exact archived application statement1634–1726; full-policy callbacks remain deferred.
test("main inference publishes before accepting and preserves an existing gate", () => {
	let frame = applicationFrame(supportInput([]));
	frame.entry.outcome.gate = "retained gate";
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual(["stance.changed"]);
	expect(frame.entry.outcome.status).toBe("accepted");
	expect(frame.entry.outcome.gate).toBe("retained gate");
	expect(replay(frame.context.working.events)).toEqual(frame.context.working);
});
test.each([[[], 1], [["Jules"], 2], [["Mina", "Mina"], 1]] as const)(
	"distinct supporters %j yield %i published events",
	(participants, count) => {
		let frame = applicationFrame(supportInput([...participants]));
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.events).toHaveLength(count);
		expect(frame.context.working.threads[0]!.status).toBe(count === 2 ? "leaning" : "exploring");
		expect(frame.entry.outcome.gate).toBe("accepted");
		expect(replay(frame.context.working.events)).toEqual(frame.context.working);
	},
);
test("leaning and assent use successive working versions and the retained current reference", () => {
	let frame = applicationFrame(supportInput(["Jules"], true));
	let version = frame.context.working.threads[0]!.version;
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual([
		"stance.changed",
		"thread.leaning",
		"settle.agreed",
	]);
	expect(frame.context.events.map(item => item.observedThreadVersion)).toEqual([
		version,
		version + 1,
		version + 2,
	]);
	expect(frame.entry.outcome.eventIds).toEqual(frame.context.events.map(item => item.id));
	expect(replay(frame.context.working.events)).toEqual(frame.context.working);
});
test.each([[10, ["stance.changed", "thread.leaning"]], [11, ["stance.changed"]]] as const)(
	"synthetic batch of %i preserves each original follow-up cap",
	(count, types) => {
		let frame = applicationFrame(supportInput(["Jules"], true));
		frame.context.events.push(...batchEvents(frame.proposed, count));
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.events.slice(count).map(item => item.type)).toEqual([...types]);
		expect(frame.context.events).toHaveLength(12);
		expect(frame.entry.outcome.status).toBe("accepted");
	},
);
test.each([[0.699, false], [0.7, true]] as const)(
	"raw assent score %f preserves threshold",
	(score, agreed) => {
		let input = supportInput([], true, "This seems sensible.");
		input.candidates[0]!.answers.option = rawChoice("none");
		input.candidates[0]!.answers.chosen_option = rawChoice("none");
		input.candidates[0]!.answers.agrees_with_settle = { type: "noul", noul: score };
		let frame = applicationFrame(input);
		expect(frame.proposed.type).toBe("stance.changed");
		if (frame.proposed.type !== "stance.changed") throw new Error("expected stance");
		expect(frame.proposed.optionId).toBeUndefined();
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.events.some(item => item.type === "settle.agreed")).toBe(agreed);
	},
);
test("a conflicting raw option blocks assent despite a high agreement score", () => {
	let input = supportInput([], true, "This seems sensible.");
	input.candidates[0]!.answers.option = rawChoice("beta");
	input.candidates[0]!.answers.chosen_option = rawChoice("none");
	input.candidates[0]!.answers.agrees_with_settle = { type: "noul", noul: 0.95 };
	let frame = applicationFrame(input);
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual(["stance.changed"]);
});
test("captured option permits bare assent after the raw answer changes to none", () => {
	let input = supportInput([], true, "yes");
	let frame = applicationFrame(input);
	frame.role.option = "alpha"; // Explicit synthetic capture control; no reclassification.
	input.candidates[0]!.answers.option = rawChoice("none");
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual(["stance.changed", "settle.agreed"]);
});
test("the proposer cannot create their own agreement", () => {
	let input = supportInput([], true);
	input.message.author = { kind: "member", handle: "Jules" };
	let frame = applicationFrame(input);
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual(["stance.changed"]);
});

test("reopening proposals remain review outcomes and retain their existing review record", () => {
	let frame = applicationFrame(decidedInput());
	expect(frame.proposed.type).toBe("candidate.proposed");
	expect(frame.context.reviews).toHaveLength(1);
	frame.entry.outcome.gate = "no useful role";
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.entry.outcome.status).toBe("review");
	expect(frame.entry.outcome.gate).toBe("review");
	expect(frame.context.reviews).toHaveLength(1);
	expect(frame.context.events.map(item => item.type)).toEqual(["candidate.proposed"]);
	expect(replay(frame.context.working.events)).toEqual(frame.context.working);
});
