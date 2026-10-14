import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import { StorageError } from "../storage/errors";
import { QUIET_MS } from "./admission";
import { runtimeFixture } from "./runtime.test-fixtures";

async function pending(f: Awaited<ReturnType<typeof runtimeFixture>>) {
	await f.say("m1", "Explore how people find decisions.");
	f.advance(QUIET_MS);
	await f.runtime.run(f.plan.id);
	return f.plan.documentDevelopment!.pending!.jobId!;
}

test("crossed pause and resume finish with the latest durable intent", async () => {
	let f = await runtimeFixture();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	try {
		let id = await pending(f);
		let get = f.jobs.get.bind(f.jobs);
		let first = true;
		f.jobs.get = async (...args) => {
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return get(...args);
		};
		let pause = f.runtime.pause(f.plan, true);
		await entered.promise;
		let resume = f.runtime.pause(f.plan, false);
		await Bun.sleep(0);
		release.resolve();
		await Promise.all([pause, resume]);
		expect(f.plan.documentDevelopment?.paused).toBe(false);
		expect((await get(f.plan.id, id))?.job.state).toBe("pending");
	} finally {
		release.resolve();
		await f.close();
	}
});

test("pause crossing enqueue also pauses the linked worker", async () => {
	let f = await runtimeFixture();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	try {
		await f.say("m1", "Explore how people find decisions.");
		f.advance(QUIET_MS);
		let enqueue = f.jobs.enqueueScheduler.bind(f.jobs);
		f.jobs.enqueueScheduler = async request => {
			entered.resolve();
			await release.promise;
			return enqueue(request);
		};
		let run = f.runtime.run(f.plan.id);
		await entered.promise;
		let pause = f.runtime.pause(f.plan, true);
		await Bun.sleep(0);
		release.resolve();
		await Promise.all([run, pause]);
		let id = f.plan.documentDevelopment!.pending!.jobId!;
		expect(f.plan.documentDevelopment?.paused).toBe(true);
		expect((await f.jobs.get(f.plan.id, id))?.job).toMatchObject({
			state: "paused",
			reason: "document-paused",
		});
	} finally {
		release.resolve();
		await f.close();
	}
});

for (let desired of [true, false]) {
	test(`restart reconciles a ${desired ? "pause" : "resume"} whose job transition failed`, async () => {
		let f = await runtimeFixture();
		try {
			let id = await pending(f);
			if (!desired) await f.runtime.pause(f.plan, true);
			let method: "pause" | "resume" = desired ? "pause" : "resume";
			let fault = spyOn(f.jobs, method).mockRejectedValue(new Error("job transition interrupted"));
			await expect(f.runtime.pause(f.plan, desired)).rejects.toThrow("job transition interrupted");
			fault.mockRestore();
			await f.reopen();
			await f.runtime.run(f.plan.id);
			expect(f.plan.documentDevelopment?.paused).toBe(desired);
			expect((await f.jobs.get(f.plan.id, id))?.job.state).toBe(desired ? "paused" : "pending");
		} finally {
			await f.close();
		}
	});
}

test("owner recovery cannot leave a durably paused document's worker pending", async () => {
	let f = await runtimeFixture();
	try {
		let id = await pending(f);
		let detail = (await f.jobs.get(f.plan.id, id))!;
		await f.jobs.pause(
			{ channelId: f.plan.id, jobId: id, expectedRevision: detail.job.revision },
			"owner-unavailable",
		);
		await f.runtime.pause(f.plan, true);
		detail = (await f.jobs.get(f.plan.id, id))!;
		if (detail.job.reason === "owner-unavailable") {
			await f.jobs.resume({
				channelId: f.plan.id,
				jobId: id,
				expectedRevision: detail.job.revision,
			});
		}
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.get(f.plan.id, id))?.job).toMatchObject({
			state: "paused",
			reason: "document-paused",
		});
	} finally {
		await f.close();
	}
});

test("pause recovers an enqueue whose sidecar link did not commit", async () => {
	let f = await runtimeFixture();
	try {
		await f.say("m1", "Develop a clearer account.");
		f.advance(QUIET_MS);
		let commit = f.storage.collaboration.commit.bind(f.storage.collaboration);
		let commits = 0;
		let fault = spyOn(f.storage.collaboration, "commit").mockImplementation(async request => {
			if (++commits === 2) throw new Error("link interrupted");
			return commit(request);
		});
		await expect(f.runtime.run(f.plan.id)).rejects.toThrow("link interrupted");
		fault.mockRestore();
		await f.runtime.pause(f.plan, true);
		let id = f.plan.documentDevelopment!.pending!.jobId!;
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
		expect((await f.jobs.get(f.plan.id, id))?.job).toMatchObject({
			state: "paused",
			reason: "document-paused",
		});
	} finally {
		await f.close();
	}
});

test("resume recovers an owner-paused worker after owner recovery was gated by the document pause", async () => {
	let f = await runtimeFixture();
	try {
		let id = await pending(f);
		await f.runtime.pause(f.plan, true);
		let detail = (await f.jobs.get(f.plan.id, id))!;
		await f.jobs.resume({ channelId: f.plan.id, jobId: id, expectedRevision: detail.job.revision });
		detail = (await f.jobs.get(f.plan.id, id))!;
		await f.jobs.pause(
			{ channelId: f.plan.id, jobId: id, expectedRevision: detail.job.revision },
			"owner-unavailable",
		);
		await f.runtime.pause(f.plan, false);
		expect((await f.jobs.get(f.plan.id, id))?.job.state).toBe("pending");
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("job revision conflicts are reread before applying durable pause intent", async () => {
	let f = await runtimeFixture();
	try {
		let id = await pending(f);
		let pause = f.jobs.pause.bind(f.jobs);
		let calls = 0;
		let fault = spyOn(f.jobs, "pause").mockImplementation(async (...args) => {
			if (++calls === 1) throw new StorageError("conflict", "concurrent runner transition");
			return pause(...args);
		});
		await f.runtime.pause(f.plan, true);
		fault.mockRestore();
		expect(calls).toBe(2);
		expect((await f.jobs.get(f.plan.id, id))?.job.state).toBe("paused");
	} finally {
		await f.close();
	}
});

for (let transient of ["owner", "lifecycle"]) {
	test(`${transient} loss after authorization retains completed output for recovery`, async () => {
		let f = await runtimeFixture();
		try {
			await pending(f);
			await f.settle({
				changes: [{ id: null, markdown: "Proposal: test discoverability.", sourceIds: ["m1"] }],
				removals: [],
			});
			let authorize = f.options.authorize;
			f.options.authorize = async () => {
				if (transient === "lifecycle") f.active(false);
				return { valid: () => transient !== "owner", release() {} };
			};
			await f.runtime.run(f.plan.id);
			expect(f.plan.documentDevelopment?.pending?.jobId).toBeDefined();
			expect(room.project(f.plan.document)).not.toContain("Proposal:");
			f.options.authorize = authorize;
			f.active(true);
			await f.runtime.run(f.plan.id);
			expect(room.project(f.plan.document)).toContain("Proposal: test discoverability.");
		} finally {
			await f.close();
		}
	});
}

test("newer explicit human direction invalidates old output and enters the next ordinary snapshot", async () => {
	let f = await runtimeFixture();
	try {
		await pending(f);
		await f.settle({
			changes: [{ id: null, markdown: "Proposal: rename it Choice.", sourceIds: ["m1"] }],
			removals: [],
		});
		await f.say("m2", "@chopin correction: keep Decision", "ana", "planner");
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).not.toContain("rename it Choice");
		expect(f.plan.documentDevelopment?.lastOutcome).toBe("stale");
		f.advance(60_000);
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
		await f.say("m3", "Let's test how people create a Decision.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending?.input.messages.map(message => message.id)).toEqual([
			"m1",
			"m2",
			"m3",
		]);
	} finally {
		await f.close();
	}
});
