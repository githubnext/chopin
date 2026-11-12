import { expect, test } from "bun:test";

import { tooltipText, tooltipTrigger } from "./icon-tooltip";

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

test("a tooltip that begins with chopin's name keeps its lower case", () => {
	expect(tooltipText("chopin is off", false)).toBe("chopin is off");
	expect(tooltipText("chopinesque", false)).toBe("Chopinesque");
});

test("hover tooltips never show on coarse pointers", () => {
	expect(tooltipTrigger("hover", { coarse: true, focusVisible: false })).toBe(false);
	expect(tooltipTrigger("hover", { coarse: false, focusVisible: false })).toBe(true);
});

test("focus tooltips need keyboard focus", () => {
	expect(tooltipTrigger("focus", { coarse: false, focusVisible: false })).toBe(false);
	expect(tooltipTrigger("focus", { coarse: true, focusVisible: true })).toBe(true);
});
