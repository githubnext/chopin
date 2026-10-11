import { expect, test } from "bun:test";

import { isTouched, setTouched } from "./touched";

test("touched cards are remembered for the session, even without storage", () => {
	expect(isTouched("card")).toBe(false);
	setTouched("card", true);
	expect(isTouched("card")).toBe(true);
	setTouched("card", false);
	expect(isTouched("card")).toBe(false);
});
