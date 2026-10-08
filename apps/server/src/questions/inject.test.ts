import { afterEach, expect, test } from "bun:test";

import * as Marks from "../comments/inject";
import * as Inject from "./inject";

let saved = { ...process.env };
afterEach(() => {
	process.env = { ...saved };
});

function plan(records = 0, threads = 0) {
	return {
		records: new Map(Array.from({ length: records }, (_, i) => [String(i), {}])),
		threads: new Map(Array.from({ length: threads }, (_, i) => [String(i), {}])),
	} as never;
}

test("dev seeding runs once per document, not on every open", () => {
	process.env.DEV_QUESTIONS = "1";
	process.env.DEV_COMMENTS = "1";
	process.env.NODE_ENV = "development";
	expect(Inject.enabled(plan())).toBe(true);
	expect(Marks.enabled(plan())).toBe(true);
	// Reopen, rename or a second client: the seeded records are already durable.
	expect(Inject.enabled(plan(2))).toBe(false);
	expect(Marks.enabled(plan(0, 1))).toBe(false);
});

test("dev seeding is off without its flag and in production", () => {
	process.env.NODE_ENV = "development";
	delete process.env.DEV_QUESTIONS;
	delete process.env.DEV_COMMENTS;
	expect(Inject.enabled(plan())).toBe(false);
	process.env.DEV_QUESTIONS = "1";
	process.env.DEV_COMMENTS = "1";
	process.env.NODE_ENV = "production";
	expect(Inject.enabled(plan())).toBe(false);
	expect(Marks.enabled(plan())).toBe(false);
});
