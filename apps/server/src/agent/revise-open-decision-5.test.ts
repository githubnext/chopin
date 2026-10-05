import { expect, spyOn, test } from "bun:test";
import { toolbox } from "./scoped-tools.test-bridge";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { createReviseOpenDecisionFixture } from "./revise-open-decision.test-fixtures";

let contexts: ReturnType<typeof createReviseOpenDecisionFixture>["contexts"];
let fixture = createReviseOpenDecisionFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened } = fixture;

test("an active implementation refuses direct card edits", async () => {
	let context = await opened();
	let active = spyOn(Service, "implementationActive").mockReturnValue(true);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await context.call({
				revision: context.plan.revision,
				id: context.id,
				title: "Why now?",
			}),
		).toContain("implementation is active");
	} finally {
		active.mockRestore();
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
});

test("a queued direct tool cannot write after the member turn changes", async () => {
	let context = await opened();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let found = toolbox({
		plan: context.plan,
		server: context.server,
		room: "test",
		persist: () => Service.persist(context.plan),
		exclusive: action => {
			entered.resolve();
			return release.promise.then(() => Service.exclusive(context.plan, action));
		},
		async publish() {},
		anchors() {},
		changes() {},
		currentMemberRequest: () => context.plan.chat.activeRequest,
	}).find(item => item.name === "revise_open_decision")!;
	context.plan.chat.activeRequest = {
		entryId: "m1",
		userId: "u1",
		handle: "ana",
		text: "Revise the Authentication decision question",
		claimantSessionId: "s1",
		turnId: "turn-1",
		lifecycle: 1,
	};
	let pending = Promise.resolve(found.handler!({
		revision: context.plan.revision,
		id: context.id,
		title: "Why now?",
	}, {} as never)).then(String);
	await entered.promise;
	context.plan.chat.turn = {
		id: "turn-2",
		handle: "ana",
		started: 2,
		entryOffset: 0,
		responded: false,
	};
	release.resolve();
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await pending).toContain("Planner turn changed");
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
});

test("a replaced member request cannot publish a staged card edit", async () => {
	let context = await opened();
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
		let pending = context.call({
			revision: context.plan.revision,
			id: context.id,
			title: "Why now?",
		});
		await entered.promise;
		context.request({ text: "@chopin revise another decision question" });
		release.resolve();
		expect(await pending).toContain("Planner turn changed");
	} finally {
		held.mockRestore();
		errors.mockRestore();
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.broadcasts).toHaveLength(broadcasts);
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.question).toBe(
		"What auth system should we use?",
	);
});
