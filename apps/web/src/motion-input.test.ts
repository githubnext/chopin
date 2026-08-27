import { expect, test } from "bun:test";
import { motionImmediately } from "./motion-input";

test("settles keyboard-owned surfaces immediately", () => {
	expect(motionImmediately({ motionInput: "keyboard" })).toBe(true);
	expect(motionImmediately({ motionInput: "pointer" })).toBe(false);
	expect(motionImmediately({})).toBe(false);
	expect(motionImmediately()).toBe(false);
});

test("settles reduced-motion pointer surfaces immediately", () => {
	expect(motionImmediately({ motionInput: "pointer" }, true)).toBe(true);
});
