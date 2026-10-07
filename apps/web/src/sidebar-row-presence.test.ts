import { expect, test } from "bun:test";

import { initialTrack, nextTrack, presenceRows } from "./sidebar-row-presence";

let g = (...ids: string[]) => ids.map(id => ({ parent: { id } }));
let ids = (rows: ReturnType<typeof presenceRows>) =>
	rows.map(row => `${row.group.parent.id}${row.enter ? "+" : ""}${row.exiting ? "-" : ""}`);

test("loaded rows are baseline", () => {
	let groups = g("a", "b");
	let track = initialTrack(groups, true, "active");
	expect(ids(presenceRows(track, groups))).toEqual(["a", "b"]);
});

test("loading to ready does not animate", () => {
	let track = initialTrack(g(), false, "active");
	let loading = nextTrack(track, g("a"), false, "active", false);
	let ready = nextTrack(loading, g("a", "b"), true, "active", false);
	expect(ids(presenceRows(ready, g("a", "b")))).toEqual(["a", "b"]);
});

test("scope change resets without animation", () => {
	let track = initialTrack(g("a", "b"), true, "active");
	let next = nextTrack(track, g("c"), true, "archived", false);
	expect(ids(presenceRows(next, g("c")))).toEqual(["c"]);
});

test("insert marks the row as entering", () => {
	let track = initialTrack(g("a"), true, "active");
	let groups = g("a", "b");
	expect(ids(presenceRows(nextTrack(track, groups, true, "active", false), groups))).toEqual([
		"a",
		"b+",
	]);
});

test("removal retains the row at its index", () => {
	let track = initialTrack(g("a", "b", "c"), true, "active");
	let groups = g("a", "c");
	expect(ids(presenceRows(nextTrack(track, groups, true, "active", false), groups))).toEqual([
		"a",
		"b-",
		"c",
	]);
});

test("re-insert during exit cancels the exit", () => {
	let track = initialTrack(g("a", "b"), true, "active");
	let removed = nextTrack(track, g("a"), true, "active", false);
	let groups = g("a", "b");
	let back = nextTrack(removed, groups, true, "active", false);
	expect(ids(presenceRows(back, groups))).toEqual(["a", "b+"]);
});

test("immediately skips animation", () => {
	let track = initialTrack(g("a", "b"), true, "active");
	let groups = g("b", "c");
	expect(ids(presenceRows(nextTrack(track, groups, true, "active", true), groups))).toEqual([
		"b",
		"c",
	]);
});

test("exit index clamps to the list end", () => {
	let track = initialTrack(g("a", "b", "c"), true, "active");
	let groups = g("a");
	expect(ids(presenceRows(nextTrack(track, groups, true, "active", false), groups))).toEqual([
		"a",
		"b-",
		"c-",
	]);
	let tail = nextTrack(
		initialTrack(g("a", "b", "c"), true, "active"),
		g("a", "b"),
		true,
		"active",
		false,
	);
	let shrunk = { ...tail, groups: g("a") };
	expect(ids(presenceRows(shrunk, g("a")))).toEqual(["a", "c-"]);
});

test("a refetch keeps rows already exiting", () => {
	let track = initialTrack(g("a", "b"), true, "active");
	let removed = nextTrack(track, g("a"), true, "active", false);
	let refetch = nextTrack(removed, g("a"), false, "active", false);
	expect(ids(presenceRows(refetch, g("a")))).toEqual(["a", "b-"]);
});
