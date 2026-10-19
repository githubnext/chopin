import { expect, spyOn, test } from "bun:test";
import * as Chat from "../chat/service";
import { authenticatedMemory } from "../chat/job-authenticated-memory.test-fixtures";
import { fixture } from "../questions/decision-followup.test-fixtures";
import { scopeSnapshot } from "../questions/decision-followup";
import * as PlanRoom from "../plan/room";
import { createConversationRuntime } from "./runtime";
import type { Room } from "../rooms";

async function setup() {
	let opened = await fixture();
	let id = opened.ids[0]!;
	await opened.save(id, "Keep offline operation.");
	let snapshot = scopeSnapshot(opened.plan, id);
	let auth = await authenticatedMemory(opened, "decision-followup", {
		name: "write_decision_scope",
		input: {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Offline operation is required.",
		},
	});
	auth.context.visualAdmission = async () => [];
	auth.onResult(async () => {
		auth.driver.finish();
	});
	let runtime = createConversationRuntime({
		config: { agent: true, conversationPlan: false },
		server: () => opened.server,
		unavailable: () => false,
	});
	auth.context.ownerAvailable = async () => {
		runtime.wake(opened.plan);
	};
	await opened.storage.channels.claimAgentOwner(opened.plan.id, auth.sessionId, new Date());
	await runtime.attach(
		{ id: opened.plan.id, plan: opened.plan, members: new Map() } as Room,
		opened.plan,
		false,
	);
	for (let attempt = 0; attempt < 30 && !runtime.jobs(opened.plan)!.jobs().length; attempt++) {
		await Bun.sleep(5);
	}
	return { opened, id, auth, runtime };
}

test("ownership lost between readiness and startup stays pending until availability returns", async () => {
	let { opened, id, auth, runtime } = await setup();
	let read = opened.storage.channels.readAgent.bind(opened.storage.channels);
	let reads = 0;
	let available = false;
	let held = spyOn(opened.storage.channels, "readAgent").mockImplementation((...args) => {
		reads++;
		return reads === 1 || available ? read(...args) : Promise.resolve(undefined);
	});
	try {
		runtime.bind(auth.context);
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]).toMatchObject({ status: "pending", attempts: 0 });
		expect(auth.driver.starts()).toBe(0);
		expect(reads).toBeLessThanOrEqual(3);
		expect(opened.plan.records.get(id)!.followUp!.appliedGeneration).toBeUndefined();
		available = true;
		await auth.context.ownerAvailable!();
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]!.status).toBe("done");
		expect(auth.driver.starts()).toBe(1);
		expect(PlanRoom.project(opened.plan.document)).toContain("Offline operation is required.");
	} finally {
		held.mockRestore();
		auth.revokeAll();
		await runtime.stop(opened.plan);
	}
});

test("an unavailable live owner binding does not wake its own deferred follow-up", async () => {
	let { opened, auth, runtime } = await setup();
	let activeOwner = auth.context.activeOwner!;
	let lookups = 0;
	// Bound a regression's self-wake loop so it fails without leaving a spinning runtime.
	auth.context.activeOwner = async () => ++lookups <= 3 ? undefined : activeOwner();
	try {
		runtime.bind(auth.context);
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]).toMatchObject({ status: "pending", attempts: 0 });
		expect(lookups).toBeLessThanOrEqual(2);
		expect(auth.driver.starts()).toBe(0);
		auth.context.activeOwner = activeOwner;
		await auth.context.ownerAvailable!();
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]!.status).toBe("done");
		expect(auth.driver.starts()).toBe(1);
	} finally {
		auth.revokeAll();
		await runtime.stop(opened.plan);
	}
});

test("queue saturation after readiness defers once and foreground completion wakes the retry", async () => {
	let { opened, auth, runtime } = await setup();
	let read = opened.storage.channels.readAgent.bind(opened.storage.channels);
	let filled = false;
	let held = spyOn(opened.storage.channels, "readAgent").mockImplementation((...args) => {
		if (!filled) {
			filled = true;
			opened.plan.chat.busy = true;
			opened.plan.chat.waiting = Array.from({ length: 20 }, (_, index) => ({
				id: `queued-${index}`,
				handle: "ana",
				text: "Existing queued work.",
			}));
		}
		return read(...args);
	});
	try {
		runtime.bind(auth.context);
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]).toMatchObject({ status: "pending", attempts: 0 });
		expect(auth.driver.starts()).toBe(0);
		opened.plan.chat.waiting = [];
		opened.plan.chat.busy = false;
		let open = auth.context.openPlannerSession!;
		auth.context.openPlannerSession = async (owner, channel) =>
			channel.room.plan.chat.job ? open(owner, channel) : {
				ok: true,
				value: {
					stream: async () =>
						({
							fullStream: (async function*() {
								yield { type: "text-start", id: "foreground" };
								yield { type: "text-delta", id: "foreground", text: "Existing work finished." };
								yield { type: "text-end", id: "foreground" };
							})(),
						}) as never,
					destroy: async () => {},
				},
			};
		await Chat.instruct(auth.context, "ana", "Finish existing work.", "Existing work completed.");
		await opened.plan.chat.running;
		await runtime.jobs(opened.plan)!.idle();
		expect(runtime.jobs(opened.plan)!.jobs()[0]!.status).toBe("done");
		expect(auth.driver.starts()).toBe(1);
		expect(PlanRoom.project(opened.plan.document)).toContain("Offline operation is required.");
	} finally {
		held.mockRestore();
		auth.revokeAll();
		await runtime.stop(opened.plan);
	}
});
