import { expect, test } from "bun:test";
import { applyCandidateEvent } from "./policy-candidate-application";
import { applicationFrame, supportInput } from "./policy-candidate-application.test-fixtures";
import { decidedInput } from "./policy-candidate-stance.test-fixtures";

test("main inference rejection keeps the original state and publications", () => {
	let frame = applicationFrame(supportInput([])), before = frame.context.working;
	frame.proposed.observedThreadVersion++;
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.working).toBe(before);
	expect(frame.context.events).toHaveLength(0);
	expect(frame.entry.outcome.eventIds).toHaveLength(0);
	expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
});

test("a rejected reopening proposal retains the review created before application", () => {
	let frame = applicationFrame(decidedInput());
	frame.proposed.observedThreadVersion++;
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.reviews).toHaveLength(1);
	expect(frame.context.events).toHaveLength(0);
	expect(frame.entry.outcome.status).toBe("review");
	expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
});
