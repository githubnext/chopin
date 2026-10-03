import { expect, test } from "bun:test";
import { replay } from "./domain";
import { applyEvent } from "./events";
import { runCandidateVerification } from "./policy-candidate-verification";
import {
	verificationFrame,
	verificationInput,
} from "./policy-candidate-verification.test-fixtures";
import { roleInput } from "./policy-candidate-entry.test-fixtures";
import { activeSettleDeferral } from "./preference";

test("valid deferred domain history resumes exact proposal and marks its outcome before skipping", () => {
	let input = verificationInput();
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = verificationFrame(input);
	let before = structuredClone(input);
	expect(runCandidateVerification(context, entry, role)).toBeUndefined();
	let event = context.events[0]!;
	expect(event.type).toBe("settle.resumed");
	if (event.type !== "settle.resumed") throw new Error("expected resume");
	expect(event.proposalId).toBe("proposal-event");
	expect(event.deferredEventId).toBe("defer-event");
	expect(entry.outcome.eventIds).toEqual([event.id]);
	expect(entry.outcome.status).toBe("accepted");
	expect(entry.outcome.gate).toBe("accepted");
	expect(activeSettleDeferral(context.working.threads[0]!, context.working.events)).toBeUndefined();
	expect(replay(context.working.events)).toEqual(context.working);
	expect(input).toEqual(before);
});

test.each(["weak evidence", "wrong chosen option", "wrong subject"])(
	"verification %s falls through without mutation",
	kind => {
		let input = verificationInput();
		if (kind === "weak evidence") input.first.evidence = { type: "noul", noul: 0.79 };
		if (kind === "wrong chosen option") {
			input.candidates[0]!.answers.chosen_option = {
				type: "choice",
				choice: "other",
				confidence: 0.95,
				probabilities: { other: 0.95, none: 0.05 },
			};
		}
		if (kind === "wrong subject") {
			input.message.text = "Latency is verified.";
			input.candidates[0]!.quote = input.message.text;
			input.candidates[0]!.end = input.message.text.length;
		}
		let { context, entry, role } = verificationFrame(input);
		let working = context.working;
		expect(runCandidateVerification(context, entry, role)).toEqual({ spikeLabel: undefined });
		expect(context.working).toBe(working);
		expect(context.events).toHaveLength(0);
	},
);

test("a discarded working thread rejects verification while captured thread history stays open", () => {
	let { context, entry, role } = verificationFrame();
	context.working = applyEvent(context.working, {
		id: "discard",
		type: "thread.discarded",
		threadId: "provider",
		observedThreadVersion: context.working.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Mina" },
		at: 1001,
	});
	let working = context.working;
	expect(role.thread!.status).toBe("exploring");
	expect(runCandidateVerification(context, entry, role)).toBeUndefined();
	expect(context.working).toBe(working);
	expect(entry.outcome.gate).toBe("verification needs review");
	expect(entry.outcome.status).toBe("review");
	expect(context.events).toHaveLength(0);
});

test.each([false, true])(
	"spike preference caches label or skips its immediate condition: %s",
	conditional => {
		let input = roleInput("support", "I'd pick Alpha for a spike;");
		if (conditional) input.message.text += " if latency stays low.";
		let { context, entry, role } = verificationFrame(input);
		let result = runCandidateVerification(context, entry, role);
		if (conditional) {
			expect(result).toBeUndefined();
			expect(entry.outcome.status).toBe("review");
			expect(entry.outcome.gate).toBe("spike choice has an immediate condition");
		} else {
			expect(result).toEqual({ spikeLabel: "Alpha" });
			entry.candidate.quote = "I'd pick Beta for a spike;";
			expect(result!.spikeLabel).toBe("Alpha");
		}
		expect(context.events).toHaveLength(0);
	},
);
