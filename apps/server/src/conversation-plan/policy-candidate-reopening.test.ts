import { expect, test } from "bun:test";
import { replay } from "./domain";
import { reopeningInput, resolutionFrame } from "./policy-candidate-resolution.test-fixtures";
import { runReopening } from "./policy-candidate-reopening";

test.each([{ first: 0.8, follow: 0.8 }, { first: 0.799, follow: 0.8 }, {
	first: 0.8,
	follow: 0.799,
}])("explicit reopening thresholds $first/$follow", ({ first, follow }) => {
	let input = reopeningInput();
	input.first.reopening = { type: "noul", noul: first };
	input.candidates[0]!.answers.reopening = { type: "noul", noul: follow };
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = resolutionFrame(input);
	let result = runReopening(context, entry, role);
	expect(result).toBeDefined();
	if (first === 0.8 && follow === 0.8) {
		expect(result?.proposed?.type).toBe("candidate.proposed");
		expect(context.reviews).toHaveLength(1);
	} else {
		expect(result?.proposed).toBeUndefined();
		expect(entry.outcome.gate).toBe("reopening needs review");
		expect(context.reviews).toHaveLength(0);
	}
	expect(context.events).toHaveLength(0);
});
test("duplicate reopening review is an explicit handled skip", () => {
	let { context, entry, role } = resolutionFrame(reopeningInput());
	context.reviews.push({ id: "existing", kind: "reopening", targetId: "provider" });
	expect(runReopening(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("reopening review already proposed from this message");
});
test.each(["base", "source", "text"])(
	"reopening %s construction failure precedes review push",
	failure => {
		let { context, entry, role } = resolutionFrame(reopeningInput());
		let quote = entry.candidate.quote, reads = 0;
		Object.defineProperty(entry.candidate, "quote", {
			get() {
				reads++;
				if (failure !== "base" && reads === (failure === "source" ? 2 : 3)) {
					throw new Error(failure + " read");
				}
				return quote;
			},
		});
		if (failure === "base") {
			context.working.threads.find = () => {
				throw new Error("base read");
			};
		}
		expect(() => runReopening(context, entry, role)).toThrow(failure + " read");
		expect(reads).toBe(failure === "base" ? 1 : failure === "source" ? 2 : 3);
		expect(context.reviews).toHaveLength(0);
		expect(context.events).toHaveLength(0);
	},
);
test.each([false, true])("reopening review push failure preserves partial review $0", partial => {
	let { context, entry, role } = resolutionFrame(reopeningInput());
	let quote = entry.candidate.quote, reads = 0;
	Object.defineProperty(entry.candidate, "quote", {
		get() {
			reads++;
			return quote;
		},
	});
	context.reviews.push = function(this: typeof context.reviews, ...items) {
		expect(reads).toBe(3);
		if (partial) Array.prototype.push.call(this, items[0]!);
		throw new Error("review push");
	};
	expect(() => runReopening(context, entry, role)).toThrow("review push");
	expect(context.reviews).toHaveLength(partial ? 1 : 0);
	expect(context.events).toHaveLength(0);
	expect(entry.outcome.status).toBe("ignored");
});
