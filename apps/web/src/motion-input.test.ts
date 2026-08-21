import { expect, test } from "bun:test";
import { motionInput } from "./motion-input";

test("classifies only input events that should change motion", () => {
	expect(motionInput("keydown")).toBe("keyboard");
	expect(motionInput("pointerdown")).toBe("pointer");
	expect(motionInput("focusin")).toBeUndefined();
});
