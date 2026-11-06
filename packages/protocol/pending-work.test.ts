import { beforeEach, expect, test } from "bun:test";

import { PendingWork } from "./pending-work";

let work = new PendingWork();

beforeEach(() => {
	work = new PendingWork();
});

test("nothing is pending until a source says it holds work, and again once it lets go", () => {
	expect(work.any()).toBe(false);
	let source = { unsaved: false };
	work.track(source);
	expect(work.any()).toBe(false);
	source.unsaved = true;
	expect(work.any()).toBe(true);
	source.unsaved = false;
	expect(work.any()).toBe(false);
});

test("one source with work is enough, however many hold none", () => {
	let idle = [{ unsaved: false }, { unsaved: false }];
	let busy = { unsaved: true };
	for (let source of [...idle, busy]) work.track(source);
	expect(work.any()).toBe(true);
	busy.unsaved = false;
	expect(work.any()).toBe(false);
});

test("a source reads its work when asked, not when it was tracked", () => {
	let outbox: string[] = [];
	let source = {
		get unsaved() {
			return outbox.length > 0;
		},
	};
	work.track(source);
	expect(work.any()).toBe(false);
	outbox.push("update");
	expect(work.any()).toBe(true);
	outbox.length = 0;
	expect(work.any()).toBe(false);
	expect(source.unsaved).toBe(false);
});
