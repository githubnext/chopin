import { expect, it } from "bun:test";

import { workspaceSizing } from "./workspace-sizing";

it("reserves the document minimum and removes a fixed chat maximum", () => {
	expect(workspaceSizing(1200, 500)).toEqual({ chat: 500, maximum: 750, mode: "split" });
	expect(workspaceSizing(1600, 2000)).toEqual({ chat: 1150, maximum: 1150, mode: "split" });
	expect(workspaceSizing(1200, 100)).toEqual({ chat: 250, maximum: 750, mode: "split" });
});

it("fits a preferred width without changing it as available space changes", () => {
	expect(workspaceSizing(950, 750).chat).toBe(500);
	expect(workspaceSizing(1200, 750).chat).toBe(750);
});

it("uses one full-width pane below the combined pane minimums", () => {
	expect(workspaceSizing(700, 500)).toEqual({ chat: 250, maximum: 250, mode: "split" });
	expect(workspaceSizing(699, 500)).toEqual({ chat: 699, maximum: 250, mode: "compact" });
});
