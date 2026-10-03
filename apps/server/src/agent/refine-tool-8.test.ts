import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Store from "../questions/store";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened, job, call } = fixture;

test("a job replaced during staged restoration cannot publish placement, title, or options", async () => {
	for (
		let change of [
			{ place_after: true },
			{ title: "Why now?" },
			{ add_options: [{ label: "GitHub Apps", rationale: "Uses repository access." }] },
		]
	) {
		let context = await opened();
		job(context.plan, context.id);
		let before = room.project(context.plan.document);
		let broadcasts = context.broadcasts.length;
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let original = room.restore;
		let held = spyOn(room, "restore").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		let errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			let pending = call(context, {
				revision: context.plan.revision,
				id: context.id,
				...(change.place_after
					? { place_after: { index: 0, digest: room.digests(context.plan.document)[0] } }
					: change),
			});
			await entered.promise;
			context.plan.chat.job = { ...context.plan.chat.job!, id: `refine:${context.id}:m2` };
			release.resolve();
			expect(await pending).toContain("background Planner job changed");
		} finally {
			errors.mockRestore();
			held.mockRestore();
		}
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
			"What auth system should we use?",
		);
		expect(context.plan.records.get(context.id)?.definition.questions[0]?.options).toEqual([]);
		expect(context.broadcasts).toHaveLength(broadcasts);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	}
});

test("suggest jobs reject both title and placement before changing the card", async () => {
	let context = await opened();
	job(context.plan, context.id, "suggest");
	let before = room.project(context.plan.document);
	let digest = room.digests(context.plan.document)[0]!;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await call(context, {
				revision: context.plan.revision,
				id: context.id,
				title: "Why?",
			}),
		).toContain("refine job");
		expect(
			await call(context, {
				revision: context.plan.revision,
				id: context.id,
				place_after: { index: 0, digest },
			}),
		).toContain("refine job");
		expect(room.project(context.plan.document)).toBe(before);
	} finally {
		errors.mockRestore();
	}
});

test("invalid title, options, and placement are refused before any retitle commits", async () => {
	let context = await opened();
	job(context.plan, context.id);
	let before = room.project(context.plan.document);
	let revision = Store.get(context.plan.questions, context.id)?.revision;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let invalid of [
				{ title: "First\rSecond" },
				{ title: "x".repeat(81) },
				{ title: "Why?", add_options: [{ label: "  ", rationale: "Valid" }] },
				{ title: "Why?", add_options: [{ label: "Valid", rationale: "  " }] },
				{ title: "Why?", place_after: { index: 0, digest: room.digest("changed") } },
			]
		) {
			expect(
				await call(context, {
					revision: context.plan.revision,
					id: context.id,
					...invalid,
				}),
			).toStartWith("Error:");
			expect(room.project(context.plan.document)).toBe(before);
			expect(Store.get(context.plan.questions, context.id)?.revision).toBe(revision);
		}
	} finally {
		errors.mockRestore();
	}
});
