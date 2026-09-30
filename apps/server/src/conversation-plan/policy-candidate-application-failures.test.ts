import { expect, test } from "bun:test";
import { applyCandidateEvent } from "./policy-candidate-application";
import {
	applicationFrame,
	deferralInput,
	supportInput,
} from "./policy-candidate-application.test-fixtures";
import { replay } from "./domain";
import { decidedInput } from "./policy-candidate-stance.test-fixtures";
import type { Event } from "./policy-types";

// Failure controls preserve applied state and partial publication; no rollback is added.
test("main inference rejection keeps the original state and publications", () => {
	let frame = applicationFrame(supportInput([])), before = frame.context.working;
	frame.proposed.observedThreadVersion++;
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.working).toBe(before);
	expect(frame.context.events).toHaveLength(0);
	expect(frame.entry.outcome.eventIds).toHaveLength(0);
	expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
});
test.each(["events", "ids"] as const)(
	"main %s push failure retains applied state and partial publication",
	field => {
		let frame = applicationFrame(supportInput([]));
		if (field === "events") {
			frame.context.events.push = function(...items: Event[]) {
				Array.prototype.push.apply(this, items);
				throw new Error("publication failed");
			};
		} else {frame.entry.outcome.eventIds.push = function(...items: string[]) {
				Array.prototype.push.apply(this, items);
				throw new Error("publication failed");
			};}
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.working.events.at(-1)!.type).toBe("stance.changed");
		expect(frame.context.events).toHaveLength(1);
		expect(frame.entry.outcome.eventIds).toHaveLength(field === "ids" ? 1 : 0);
		expect(frame.entry.outcome.status).toBe("review");
		expect(replay(frame.context.working.events)).toEqual(frame.context.working);
	},
);
test.each(["thread.leaning", "settle.agreed"] as const)(
	"%s publication failure retains each completed inference",
	type => {
		let frame = applicationFrame(supportInput(["Jules"], true));
		frame.context.events.push = function(...items: Event[]) {
			let length = Array.prototype.push.apply(this, items);
			if (items[0]!.type === type) throw new Error("follow-up publication failed");
			return length;
		};
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.working.events.at(-1)!.type).toBe(type);
		expect(frame.context.events.at(-1)!.type).toBe(type);
		expect(frame.entry.outcome.eventIds).toHaveLength(type === "thread.leaning" ? 1 : 2);
		expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
		expect(replay(frame.context.working.events)).toEqual(frame.context.working);
	},
);
test.each(["stance.changed", "thread.leaning"] as const)(
	"source mutation after %s publication rejects the next inference without rollback",
	type => {
		let frame = applicationFrame(supportInput(["Jules"], true));
		frame.context.events.push = function(...items: Event[]) {
			let length = Array.prototype.push.apply(this, items);
			let item = items[0]!;
			if (item.type === type && "source" in item) {
				item.source.quote = "Corrupted after publication.";
			}
			return length;
		};
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(frame.context.working.events.at(-1)!.type).toBe(type);
		expect(frame.context.events.at(-1)!.type).toBe(type);
		expect(frame.entry.outcome.eventIds).toHaveLength(type === "stance.changed" ? 1 : 2);
		expect(frame.entry.outcome.status).toBe("review");
		expect(replay(frame.context.working.events)).toEqual(frame.context.working);
	},
);
test.each([1, 2])(
	"deferral quote getter failure on read %i retains the main constraint",
	failingRead => {
		let { input, neutral } = deferralInput();
		let frame = applicationFrame(input, [neutral]), reads = 0;
		let quote = frame.entry.candidate.quote;
		Object.defineProperty(frame.entry.candidate, "quote", {
			configurable: true,
			get() {
				reads++;
				if (reads === failingRead) throw new Error("follow-up quote failed");
				return quote;
			},
		});
		applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
		expect(reads).toBe(failingRead);
		expect(frame.context.working.events.at(-1)!.type).toBe("constraint.added");
		expect(frame.context.events.map(item => item.type)).toEqual([
			"stance.changed",
			"constraint.added",
		]);
		expect(frame.entry.outcome.eventIds).toHaveLength(1);
		expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
	},
);

test("a rejected reopening proposal retains the review created before application", () => {
	let frame = applicationFrame(decidedInput());
	frame.proposed.observedThreadVersion++;
	applyCandidateEvent(frame.context, frame.entry, frame.role, frame.proposed);
	expect(frame.context.reviews).toHaveLength(1);
	expect(frame.context.events).toHaveLength(0);
	expect(frame.entry.outcome.status).toBe("review");
	expect(frame.entry.outcome.gate).toBe("domain rejected proposed event");
});
