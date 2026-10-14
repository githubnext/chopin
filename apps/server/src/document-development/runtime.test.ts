import { expect, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { runtimeFixture } from "./runtime.test-fixtures";
import { QUIET_MS } from "./admission";

test("coalesces a burst and ignores Planner messages and agent writes", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Decision means already decided to me.");
		await f.say("m2", "I cannot find how to create one.", "lily");
		let automatic = {
			id: "m3",
			text: "A Planner response.",
			author: { kind: "agent" as const },
			ts: 0,
		};
		f.plan.chat.entries.push(automatic);
		await Service.persist(f.plan);
		f.runtime.message(f.plan, automatic);
		expect(f.timers.filter(timer => !timer.cancelled)).toHaveLength(1);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending).toBeUndefined();
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending?.input.messages.map(message => message.id))
			.toEqual(["m1", "m2"]);
		await f.settle({
			changes: [{
				id: null,
				markdown: "Reported problem: terminology and creation are unclear.",
				sourceIds: ["m1", "m2"],
			}],
			removals: [],
		});
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).toContain("Reported problem:");
		expect(f.plan.documentDevelopment?.pending).toBeUndefined();
		let revision = f.plan.revision;
		await f.runtime.run(f.plan.id);
		expect(f.plan.revision).toBe(revision);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("a completed artifact survives restart and applies once", async () => {
	let f = await runtimeFixture("# Notes\n\nHuman introduction.\n");
	try {
		await f.say("m1", "Could the next experiment test the label with one colleague?");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		await f.settle({
			changes: [{
				id: null,
				markdown: "Proposal: test the label with one colleague.",
				sourceIds: ["m1"],
			}],
			removals: [],
		});
		await f.reopen();
		await f.runtime.run(f.plan.id);
		let source = room.project(f.plan.document);
		expect(source).toContain("Human introduction.");
		expect(source.match(/Proposal:/g)).toHaveLength(1);
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).toBe(source);
	} finally {
		await f.close();
	}
});

test("changed discussion discards old results; unchanged output consumes its source", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "We could rename it Choice.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		await f.settle({
			changes: [{ id: null, markdown: "Proposal: rename it Choice.", sourceIds: ["m1"] }],
			removals: [],
		});
		await f.say("m2", "Correction: keep the term decision; test its discoverability.");
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).not.toContain("rename");
		f.advance(60_000);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending?.input.messageId).toBe("m2");
		await f.settle({ changes: [], removals: [] });
		let revision = f.plan.revision;
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.lastMessageId).toBe("m2");
		expect(f.plan.revision).toBe(revision);
	} finally {
		await f.close();
	}
});

test("pause and owner loss prevent projection without losing a completed result", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Explore discoverability.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		await f.settle({
			changes: [{
				id: null,
				markdown: "Open question: where should creation begin?",
				sourceIds: ["m1"],
			}],
			removals: [],
		});
		f.allowed(false);
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).not.toContain("Open question");
		f.allowed(true);
		await f.runtime.pause(f.plan, true);
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.paused).toBe(true);
		expect(room.project(f.plan.document)).not.toContain("Open question");
		await f.runtime.pause(f.plan, false);
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).toContain("Open question");
	} finally {
		await f.close();
	}
});

test("durable admission is recovered after enqueue fails without charging another attempt", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Develop the problem statement.");
		f.advance(QUIET_MS);
		let original = f.jobs.enqueueScheduler.bind(f.jobs);
		f.jobs.enqueueScheduler = async () => {
			throw new Error("storage unavailable");
		};
		await expect(f.runtime.run(f.plan.id)).rejects.toThrow("storage unavailable");
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(1);
		expect(f.plan.documentDevelopment?.pending?.jobId).toBeUndefined();
		f.jobs.enqueueScheduler = original;
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending?.jobId).toBeDefined();
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("implementation and unavailable channels refuse admission", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Explain the planned experience.");
		f.advance(QUIET_MS);
		f.plan.claiming = true;
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment).toBeUndefined();
		f.plan.claiming = false;
		f.active(false);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment).toBeUndefined();
		f.active(true);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending).toBeDefined();
		await Service.persist(f.plan);
	} finally {
		await f.close();
	}
});
