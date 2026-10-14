import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import type { Investigation } from "@chopin/experiment/records";
import type { Instruction } from "../chat/server-instruction";
import * as Service from "../plan/service";
import { normalizeRecord } from "../questions/records";
import { openPlan } from "../testing/plan";
import { createFollowthrough } from "./runtime";

async function fixture() {
	let context = await openPlan("# Parent\n\nCaching is our provisional recommendation.\n");
	let { plan, storage, lease, channel } = context;
	let investigation: Investigation = {
		id: crypto.randomUUID(),
		documentId: plan.id,
		requester: channel.createdBy,
		brief: "Does caching improve startup?",
		revision: 0,
		state: "publishing",
		generation: 1,
		expiresAt: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		progress: "",
		views: {},
		decisions: [],
		receipts: {},
		candidate: performance,
	};
	await storage.experiments.save(investigation, undefined, lease);
	delete investigation.candidate;
	let published = await storage.experiments.publish(
		{
			...investigation,
			revision: 1,
			state: "completed",
			result: performance,
		},
		0,
		{ title: "Evidence", initial: await Service.initial("# Evidence\n"), now: new Date() },
		lease,
	);
	if (!published) throw new Error("fixture investigation did not publish");
	let [receipt] = await storage.followthrough.forSource(plan.id, "investigation", investigation.id);
	if (!receipt) throw new Error("fixture did not enqueue follow-through");
	let state = { owner: true, attached: true };
	let instructions: Instruction[] = [];
	let queued = Promise.withResolvers<Instruction>();
	let errors: unknown[] = [];
	let coordinator = createFollowthrough({
		agent: true,
		storage,
		lease: () => lease,
		opened: () => plan,
		unavailable: () => false,
		attached: async () => state.attached,
		instruct: async (_id, compose) => {
			if (!state.owner) return false;
			let instruction = compose(plan);
			if (!instruction) return false;
			instructions.push(instruction);
			queued.resolve(instruction);
			return true;
		},
		changed: () => {},
		error: error => errors.push(error),
	});
	return {
		...context,
		coordinator,
		state,
		instructions,
		queued: queued.promise,
		errors,
		read: () => storage.followthrough.get(plan.id, receipt!.id),
	};
}

test("preparation captures the current document revision and human decisions after queueing", async () => {
	let f = await fixture();
	try {
		let admittedRevision = f.plan.revision;
		let work = f.coordinator.wake(f.plan.id);
		let instruction = await f.queued;
		expect(await f.read()).toMatchObject({ status: "pending", attempts: 0 });
		let outcome = await Service.exclusive(f.plan, () =>
			Service.rewrite(
				f.plan,
				"# Parent\n\nThe team now prefers the simple path until real evidence supports caching.\n",
				(source, revision) => ({
					idempotencyKey: "direction-change",
					fingerprint: "direction-change",
					fromRevision: admittedRevision,
					client: { name: "test", version: "1" },
					document: {
						source,
						revision,
						title: "Parent",
						url: "/documents/owner/repository/parent",
					},
				}),
			));
		expect(outcome.ok).toBe(true);
		await Service.exclusive(f.plan, async () => {
			f.plan.records.set(
				"cache-decision",
				normalizeRecord({
					id: "cache-decision",
					status: "answered",
					origin: "planner",
					resolver: "ana",
					at: 1,
					definition: {
						questions: [{
							id: "cache",
							header: "Caching",
							question: "Should we add caching?",
							multiple: false,
							options: [{ id: "avoid", label: "Keep the simple path", description: "" }],
						}],
					},
					answers: { cache: "Keep the simple path" },
					choices: ["avoid"],
				}),
			);
			await Service.persistExclusive(f.plan);
		});
		let prepared = await instruction.about!.prepare!();
		expect(prepared.status).toBe("ready");
		if (prepared.status !== "ready") throw new Error("review was not admitted");
		expect(f.plan.revision).toBeGreaterThan(admittedRevision);
		expect(await f.read()).toMatchObject({
			status: "running",
			attempts: 1,
			context: {
				planRevision: f.plan.revision,
				sourceHash: Service.sourceHash(Service.source(f.plan)),
			},
		});
		let [admitted] = prepared.text.split(
			"Current admission context (read again before writing):\n",
		)[1]!
			.split("\n\nUntrusted result data");
		let current = JSON.parse(admitted!);
		expect(current.planRevision).toBe(f.plan.revision);
		expect(JSON.parse(current.decisions)).toEqual([{
			id: "cache-decision",
			status: "answered",
			questions: ["Should we add caching?"],
			answers: { cache: "Keep the simple path" },
		}]);
		expect(prepared.text).toContain("never silently replace a human decision");
		expect(instruction.about!.beforeStream!()).toBe(true);
		await instruction.about!.ended!({
			status: "done",
			text:
				"The recommendation now preserves the team's choice and links the measured limitations.",
		});
		await work;
		expect(await f.read()).toMatchObject({ status: "done", attempts: 1 });
		expect(f.errors).toEqual([]);
	} finally {
		f.coordinator.close();
		await Service.close(f.plan);
	}
});

test("a build lock after preparation releases only the unstarted attempt back to pending", async () => {
	let f = await fixture();
	try {
		let work = f.coordinator.wake(f.plan.id);
		let instruction = await f.queued;
		expect(await instruction.about!.prepare!()).toMatchObject({ status: "ready" });
		let running = (await f.read())!;
		expect(running).toMatchObject({ status: "running", attempts: 1, revision: 1 });
		f.plan.claiming = true;
		expect(await instruction.about!.beforeStream!()).toBe(false);
		let pending = (await f.read())!;
		expect(pending).toMatchObject({
			status: "pending",
			attempts: 1,
			revision: 2,
			reason: "document-locked",
		});
		expect(pending.context).toBeUndefined();
		expect(pending.attemptToken).toBeUndefined();
		await instruction.about!.ended!({ status: "skipped" });
		await work;
		expect(await f.read()).toEqual(pending);
		expect(f.instructions).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.plan.claiming = false;
		f.coordinator.close();
		await Service.close(f.plan);
	}
});

for (let reason of ["owner-unavailable", "remote-unavailable", "document-locked"] as const) {
	test(`${reason} defers runtime admission without claiming the receipt`, async () => {
		let f = await fixture();
		try {
			if (reason === "owner-unavailable") f.state.owner = false;
			else if (reason === "remote-unavailable") f.state.attached = false;
			else f.plan.claiming = true;
			await f.coordinator.wake(f.plan.id);
			expect(await f.read()).toMatchObject({ status: "pending", reason, attempts: 0 });
			expect(f.instructions).toEqual([]);
			expect(f.errors).toEqual([]);
		} finally {
			f.plan.claiming = false;
			f.coordinator.close();
			await Service.close(f.plan);
		}
	});
}

for (let reason of ["remote-unavailable", "document-locked"] as const) {
	test(`${reason} arising after queue admission still prevents a model claim`, async () => {
		let f = await fixture();
		try {
			let work = f.coordinator.wake(f.plan.id);
			let instruction = await f.queued;
			if (reason === "remote-unavailable") f.state.attached = false;
			else f.plan.claiming = true;
			expect(await instruction.about!.prepare!()).toEqual({ status: "deferred" });
			await instruction.about!.ended!({ status: "skipped" });
			await work;
			expect(await f.read()).toMatchObject({ status: "pending", reason, attempts: 0 });
			expect(f.errors).toEqual([]);
		} finally {
			f.plan.claiming = false;
			f.coordinator.close();
			await Service.close(f.plan);
		}
	});
}
