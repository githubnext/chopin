import { expect, test } from "bun:test";
import { motionImmediately, settleMotionFeedback } from "./motion-input";

test("settles keyboard-owned surfaces immediately", () => {
	expect(motionImmediately({ motionInput: "keyboard" })).toBe(true);
	expect(motionImmediately({ motionInput: "pointer" })).toBe(false);
	expect(motionImmediately({})).toBe(false);
	expect(motionImmediately()).toBe(false);
});

test("settles a feedback entrance after its first animation", () => {
	let feedback = {
		dataset: {} as Record<string, string>,
		matches: (selector: string) => selector === ".motion-feedback[data-motion-feedback]",
	};
	let other = {
		dataset: {} as Record<string, string>,
		matches: () => false,
	};

	settleMotionFeedback(feedback);
	settleMotionFeedback(other);

	expect(feedback.dataset.motionSettled).toBe("");
	expect(other.dataset.motionSettled).toBeUndefined();
});
