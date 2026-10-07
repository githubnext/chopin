import { expect, test } from "bun:test";

import { tooltipText } from "./icon-tooltip";

test("icon labels use sentence case", () => {
	expect(tooltipText(" bold text ", false)).toBe("Bold text");
});

test("verbatim labels keep their own casing", () => {
	expect(tooltipText("maggieAppleton, octocat", true)).toBe("maggieAppleton, octocat");
});

test("sentence case preserves proper names and shortcuts", () => {
	expect(tooltipText("send to Chopin", false)).toBe("Send to Chopin");
	expect(tooltipText("Open GitHub", false)).toBe("Open GitHub");
	expect(tooltipText("Shift+Tab to switch mode.", false)).toBe("Shift+Tab to switch mode.");
});
