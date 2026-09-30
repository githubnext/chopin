import { expect, test } from "bun:test";

import { tooltipText } from "./icon-tooltip";

test("icon labels are capitalised word by word", () => {
	expect(tooltipText(" bold text ", false)).toBe("Bold Text");
});

test("verbatim labels keep their own casing", () => {
	expect(tooltipText("maggieAppleton, octocat", true)).toBe("maggieAppleton, octocat");
});
