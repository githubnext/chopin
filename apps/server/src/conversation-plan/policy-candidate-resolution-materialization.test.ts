import { expect, test } from "bun:test";
import { replay } from "./domain";
import { resolutionFrame, resolutionInput } from "./policy-candidate-resolution.test-fixtures";
import { runResolution } from "./policy-candidate-resolution";

test("linked card materialization stages versions then publishes the applied state", () => {
	let input = resolutionInput(true);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = resolutionFrame(input);
	let version = role.thread!.version;
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(context.events.map(event => event.observedThreadVersion)).toEqual([version, version + 1]);
	expect(context.events[0]!).toMatchObject({
		type: "option.added",
		source: { role: "option" },
		contribution: { id: "beta", text: "Beta", authoring: "scribe", targetId: "provider" },
	});
	expect(context.events[1]!).toMatchObject({
		type: "settle.suggested",
		source: { role: "resolution" },
		optionId: "beta",
	});
	expect(context.working.threads[0]!.version).toBe(version + 2);
	expect(entry.outcome.status).toBe("accepted");
	expect(entry.outcome.eventIds).toEqual(context.events.map(event => event.id));
	expect(replay(context.working.events)).toEqual(context.working);
});
test.each([3, 4])("invalid source at quote read%s retains original working", read => {
	let { context, entry, role } = resolutionFrame(resolutionInput(true));
	let before = context.working, quote = entry.candidate.quote, reads = 0;
	Object.defineProperty(entry.candidate, "quote", {
		get() {
			return ++reads === read ? "Changed quote." : quote;
		},
	});
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(reads).toBe(read);
	expect(context.working).toBe(before);
	expect(context.events).toHaveLength(0);
	expect(entry.outcome.eventIds).toHaveLength(0);
	expect(entry.outcome.gate).toBe("linked card choice could not be suggested");
});
test.each([3, 4])("thrown source at quote read%s preserves original catch boundary", read => {
	let { context, entry, role } = resolutionFrame(resolutionInput(true));
	let before = context.working, quote = entry.candidate.quote, reads = 0;
	Object.defineProperty(entry.candidate, "quote", {
		get() {
			if (++reads === read) throw new Error("source read" + read);
			return quote;
		},
	});
	if (read === 3) {
		expect(() => runResolution(context, entry, role)).toThrow("source read3");
		expect(entry.outcome.gate).toBe("no useful role");
	} else {
		expect(runResolution(context, entry, role)).toBeUndefined();
		expect(entry.outcome.gate).toBe("linked card choice could not be suggested");
	}
	expect(reads).toBe(read);
	expect(context.working).toBe(before);
	expect(context.events).toHaveLength(0);
});
test("existing-choice source exception remains outside inference/application", () => {
	let { context, entry, role } = resolutionFrame();
	let quote = entry.candidate.quote, reads = 0;
	Object.defineProperty(entry.candidate, "quote", {
		get() {
			if (++reads === 3) throw new Error("existing source read");
			return quote;
		},
	});
	expect(() => runResolution(context, entry, role)).toThrow("existing source read");
	expect(reads).toBe(3);
	expect(context.events).toHaveLength(0);
	expect(entry.outcome.status).toBe("ignored");
});
test.each(["events", "IDs"])(
	"%s push failure retains applied materialization and partial data",
	target => {
		let { context, entry, role } = resolutionFrame(resolutionInput(true));
		let before = context.working;
		if (target === "events") {
			context.events.push = function(this: typeof context.events, ...events) {
				Array.prototype.push.call(this, events[0]!);
				throw new Error("event push");
			};
		} else {entry.outcome.eventIds.push = function(this: string[], ...ids) {
				Array.prototype.push.call(this, ids[0]!);
				throw new Error("ID push");
			};}
		expect(runResolution(context, entry, role)).toBeUndefined();
		expect(context.working).not.toBe(before);
		expect(context.working.threads[0]!.pendingSettle?.optionId).toBe("beta");
		expect(context.events).toHaveLength(target === "events" ? 1 : 2);
		expect(entry.outcome.eventIds).toHaveLength(target === "events" ? 0 : 1);
		expect(entry.outcome.gate).toBe("linked card choice could not be suggested");
		expect(replay(context.working.events)).toEqual(context.working);
	},
);
