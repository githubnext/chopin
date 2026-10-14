import { expect, spyOn, test } from "bun:test";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { runtimeFixture } from "./runtime.test-fixtures";
import { INTERVAL_MS, QUIET_MS, WINDOW_MS } from "./admission";
import { DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES } from "./schema";

test("real UUID message identities enqueue once and recover the same job", async () => {
	let f = await runtimeFixture();
	try {
		await f.say(crypto.randomUUID(), "Discuss a useful next experiment.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		let id = f.plan.documentDevelopment!.pending!.jobId;
		expect(id).toBeDefined();
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment!.pending!.jobId).toBe(id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("oversized UTF-8 context creates no reservation, attempt or model job", async () => {
	let f = await runtimeFixture(`# Notes\n\n${"界".repeat(31980)}\n`);
	try {
		for (let i = 0; i < 4; i++) await f.say(`m${i}`, "界".repeat(4000));
		let source = room.project(f.plan.document);
		expect(source.length).toBeLessThanOrEqual(32000);
		expect(f.plan.chat.entries.reduce((sum, entry) => sum + entry.text.length, 0)).toBe(16000);
		expect(Buffer.byteLength(source + f.plan.chat.entries.map(entry => entry.text).join("")))
			.toBeGreaterThan(DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES);
		let enqueue = spyOn(f.jobs, "enqueueScheduler");
		try {
			f.advance(QUIET_MS);
			await expect(f.runtime.run(f.plan.id)).resolves.toBeUndefined();
			expect(f.plan.documentDevelopment?.pending).toBeUndefined();
			expect(f.plan.documentDevelopment?.attempts ?? []).toHaveLength(0);
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			enqueue.mockRestore();
		}
		await f.reopen();
		await expect(f.runtime.run(f.plan.id)).resolves.toBeUndefined();
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
		expect(f.plan.documentDevelopment?.pending).toBeUndefined();
		expect(f.plan.documentDevelopment?.attempts ?? []).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("hourly admission budget survives restart and expires without repeated model work", async () => {
	let f = await runtimeFixture();
	try {
		for (let index = 0; index < 8; index++) {
			await f.say(`m${index}`, `Explore question ${index}.`);
			f.advance(INTERVAL_MS);
			await f.runtime.run(f.plan.id);
			await f.settle({ changes: [], removals: [] });
			await f.runtime.run(f.plan.id);
		}
		await f.reopen();
		await f.say("m8", "Consider one further question.");
		f.advance(INTERVAL_MS);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending).toBeUndefined();
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(8);
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(8);
		f.advance(WINDOW_MS);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending?.input.messageId).toBe("m8");
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("recovery reuses an enqueued job when its sidecar link did not commit", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "How can we make decisions discoverable?");
		f.advance(QUIET_MS);
		let original = f.storage.collaboration.commit.bind(f.storage.collaboration);
		let commits = 0;
		let fault = spyOn(f.storage.collaboration, "commit").mockImplementation(async request => {
			if (++commits === 2) throw new Error("link write failed");
			return original(request);
		});
		await expect(f.runtime.run(f.plan.id)).rejects.toThrow("link write failed");
		fault.mockRestore();
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
		expect(f.plan.documentDevelopment?.pending?.jobId).toBeDefined();
	} finally {
		await f.close();
	}
});

test("pause stops a queued worker and resume retains the same durable request", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "We need a more useful problem statement.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		let id = f.plan.documentDevelopment!.pending!.jobId!;
		await f.runtime.pause(f.plan, true);
		expect((await f.jobs.get(f.plan.id, id))?.job).toMatchObject({
			state: "paused",
			reason: "document-paused",
		});
		await f.reopen();
		await f.runtime.pause(f.plan, false);
		expect((await f.jobs.get(f.plan.id, id))?.job.state).toBe("pending");
		expect(f.plan.documentDevelopment?.pending?.jobId).toBe(id);
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("decision changes consume a stale admission without running its old context", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Consider the onboarding experiment.");
		f.advance(QUIET_MS);
		let enqueue = f.jobs.enqueueScheduler.bind(f.jobs);
		f.jobs.enqueueScheduler = async () => {
			throw new Error("temporarily unavailable");
		};
		await expect(f.runtime.run(f.plan.id)).rejects.toThrow();
		f.jobs.enqueueScheduler = enqueue;
		f.plan.records.set("q1", {
			id: "q1",
			status: "answered",
			origin: "planner",
			owner: "mona",
			definition: {
				questions: [{
					id: "question",
					header: "Next step",
					question: "What first?",
					multiple: false,
					options: [{ id: "a", label: "Test discoverability", description: "" }],
				}],
			},
			choices: ["a"],
			history: [],
			optionOrigins: {},
			editors: [],
		});
		await Service.persist(f.plan);
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
		expect(f.plan.documentDevelopment?.lastOutcome).toBe("stale");
	} finally {
		await f.close();
	}
});
