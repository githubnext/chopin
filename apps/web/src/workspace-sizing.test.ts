import { expect, it } from "bun:test";

import { createWorkspaceSpace, workspaceSizing } from "./workspace-sizing";

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

it("tells its listeners of each new width once, and of nothing it already has", () => {
	let space = createWorkspaceSpace(1000);
	let heard: number[] = [];
	let stop = space.subscribe(() => heard.push(space.get()));

	space.set(1000);
	space.set(990);
	space.set(990);
	space.set(980);
	stop();
	space.set(970);

	expect(heard).toEqual([990, 980]);
	expect(space.get()).toBe(970);
});
