import { expect, test } from "bun:test";
import { applyCandidateEvent } from "./policy-candidate-application";
import {
	applicationFrame,
	batchEvents,
	deferralInput,
} from "./policy-candidate-application.test-fixtures";
import { effectivePending } from "./preference";
import { replay } from "./domain";
import { applyInference } from "./domain";
import type { Event } from "./policy-types";

// Replay-valid histories; same-message neutral publications explicitly seed the batch.
test("constraint can defer the raw pending choice after its proposer withdraws", () => {
	let { input, neutral } = deferralInput();
	expect(input.state.threads[0]!.pendingSettle).toBeDefined();
	expect(effectivePending(input.state.threads[0]!, input.state.events)).toBeUndefined();
	let frame = applicationFrame(input, [neutral]);
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual([
		"stance.changed",
		"constraint.added",
		"settle.deferred",
	]);
	expect(frame.entry.outcome.eventIds).toHaveLength(2);
	expect(replay(frame.context.working.events)).toEqual(frame.context.working);
});
test.each([["Jules", false, "Let's verify backups before choosing."], [
	"Mina",
	true,
	"Let's verify backups before choosing.",
], ["Jules", true, "Let's verify backups."]])(
	"deferral retains participant, same-message and cue requirements: %s/%s/%s",
	(handle, sameMessage, quote) => {
		let { input, neutral } = deferralInput(handle, sameMessage, quote);
		let frame = applicationFrame(input, [neutral]);
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.events.map(item => item.type)).toEqual([
			"stance.changed",
			"constraint.added",
		]);
	},
);
test("an existing current deferral is not repeated", () => {
	let { input, neutral } = deferralInput();
	let deferred: Event = {
		id: "already-deferred",
		type: "settle.deferred",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		proposalId: "settle",
		source: { ...neutral.source, role: "constraint" },
	};
	input.state = applyInference(input.state, deferred, input.message);
	let frame = applicationFrame(input, [neutral]);
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events.map(item => item.type)).toEqual([
		"stance.changed",
		"constraint.added",
	]);
	expect(replay(frame.context.working.events)).toEqual(frame.context.working);
});
test("synthetic eleven-event batch reaches thirteen because constraint deferral has no support cap", () => {
	let { input, neutral } = deferralInput();
	let frame = applicationFrame(input, [...batchEvents(neutral, 10), neutral]);
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.events).toHaveLength(13);
	expect(frame.context.events.slice(11).map(item => item.type)).toEqual([
		"constraint.added",
		"settle.deferred",
	]);
	expect(frame.entry.outcome.status).toBe("accepted");
});
