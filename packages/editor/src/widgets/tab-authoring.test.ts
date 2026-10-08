import { expect, test } from "bun:test";
import { limits } from "@chopin/dialect";

import { newTabLabel, stripKey, successor, tabLabel } from "./tab-authoring";

test("a label is one trimmed line within the dialect limit", () => {
	expect(tabLabel("  Mobile\n app ")).toBe("Mobile app");
	expect(tabLabel("x".repeat(limits.MAX_TAB_LABEL + 5))).toHaveLength(limits.MAX_TAB_LABEL);
	expect(tabLabel(" \n\t ")).toBeUndefined();
});

test("a new tab takes the next free number", () => {
	expect(newTabLabel(["One", "Two"])).toBe("Tab 3");
	expect(newTabLabel(["Tab 1", "Tab 3"])).toBe("Tab 4");
	expect(newTabLabel(["tab 2"])).toBe("Tab 3");
});

test("removing a tab hands its place to the next, or the previous at the end", () => {
	expect(successor(3, 0)).toBe(0);
	expect(successor(3, 1)).toBe(1);
	expect(successor(3, 2)).toBe(1);
	expect(successor(2, 1)).toBe(0);
});

test("authoring keys apply only while editable, and never remove the last tab", () => {
	expect(stripKey("ArrowLeft", 0, 3, false)).toEqual({ type: "select", index: 2 });
	expect(stripKey("End", 0, 3, false)).toEqual({ type: "select", index: 2 });
	expect(stripKey("Enter", 0, 3, true)).toEqual({ type: "rename" });
	expect(stripKey("F2", 0, 3, false)).toBeUndefined();
	expect(stripKey("Delete", 1, 3, true)).toEqual({ type: "remove" });
	expect(stripKey("Delete", 0, 1, true)).toBeUndefined();
	expect(stripKey("Delete", 1, 3, false)).toBeUndefined();
	expect(stripKey("a", 0, 3, true)).toBeUndefined();
});
