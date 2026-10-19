import { expect, test } from "bun:test";
import { fixture, restart, running, scopeRoom } from "../questions/decision-followup.test-fixtures";
import { createConversationRuntime } from "./runtime";
import * as Jobs from "./jobs";
import type * as Chat from "../chat/service";
import type { Room } from "../rooms";
import { authenticatedMemory } from "../chat/job-authenticated-memory.test-fixtures";
import { scopeSnapshot } from "../questions/decision-followup";
import * as PlanRoom from "../plan/room";
import { writeScope } from "../questions/decision-followup-write";

test.each([false, true])(
	"a saved capture waits pending with conversation analysis off and agent=%s",
	async agent => {
		let context = await fixture();
		let errors: unknown[] = [];
		let ownershipClaims = 0;
		let ownershipReads = 0;
		let runtime = createConversationRuntime({
			config: { agent, conversationPlan: false },
			server: () => context.server,
			unavailable: () => false,
			onError: error => errors.push(error),
		});
		try {
			await runtime.attach(
				{ id: context.plan.id, plan: context.plan, members: new Map() } as Room,
				context.plan,
				false,
			);
			await context.save(context.ids[0]!, "Keep this decision across reconnect.");
			for (let attempt = 0; attempt < 30 && !runtime.jobs(context.plan)!.jobs().length; attempt++) {
				await Bun.sleep(5);
			}
			expect(runtime.jobs(context.plan)!.jobs()).toMatchObject([{
				kind: "decision-followup",
				status: "pending",
			}]);
			runtime.bind(
				{
					plan: context.plan,
					chat: context.plan.chat,
					room: context.plan.id,
					server: context.server,
					config: { agent: true },
					auth: {
						storage: {
							channels: {
								async readAgent() {
									ownershipReads++;
									return undefined;
								},
								async claimAgentOwner() {
									ownershipClaims++;
									return undefined;
								},
							},
						},
					},
				} as unknown as Chat.Room,
			);
			await runtime.jobs(context.plan)!.idle();
			expect(runtime.jobs(context.plan)!.jobs()[0]!.status).toBe("pending");
			expect(errors).toEqual([]);
			if (agent) expect(ownershipReads).toBeGreaterThan(0);
			else expect(ownershipReads).toBe(0);
			expect(ownershipClaims).toBe(0);
		} finally {
			await runtime.stop(context.plan);
		}
	},
);

test("a recovered source receipt completes without an owner, model or classifier", async () => {
	let opened = await fixture();
	let id = opened.ids[0]!;
	await opened.save(id, "Keep offline operation.");
	let snapshot = scopeSnapshot(opened.plan, id);
	let job = running(opened);
	opened.plan.conversationPlanJobs = [job];
	await writeScope(scopeRoom(opened), job, opened.plan.chat.turn, {
		id,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source: "Offline operation is required.",
	});
	let restored = await restart(opened);
	let errors: unknown[] = [];
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: false },
		server: () => restored.server,
		unavailable: () => false,
		onError: error => errors.push(error),
	});
	let revision = restored.plan.revision;
	try {
		await runtime.attach(
			{ id: restored.plan.id, plan: restored.plan, members: new Map() } as Room,
			restored.plan,
			false,
		);
		for (
			let attempt = 0;
			attempt < 30 && runtime.jobs(restored.plan)!.jobs()[0]!.status !== "done";
			attempt++
		) await Bun.sleep(5);
		expect(runtime.jobs(restored.plan)!.jobs()[0]!.status).toBe("done");
		expect(restored.plan.revision).toBe(revision);
		expect(errors).toEqual([]);
	} finally {
		await runtime.stop(restored.plan);
	}
});

test("an interrupted follow-up recovers pending so a durable source receipt can complete it", () => {
	let job = {
		id: "decision-followup:card:decided:card:1",
		kind: "decision-followup",
		target: "card",
		trigger: "decided:card:1",
		status: "running",
		attempts: 0,
		at: "2026-10-19T00:00:00.000Z",
	};
	expect(Jobs.restore([job])[0]!.status).toBe("pending");
});

test("an owner-availability callback wakes the saved answer after its foreground turn has ended", async () => {
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
	let errors: unknown[] = [];
	let runtime = createConversationRuntime({
		config: { agent: true, conversationPlan: false },
		server: () => opened.server,
		unavailable: () => false,
		onError: error => errors.push(error),
	});
	auth.context.ownerAvailable = async () => {
		runtime.wake(opened.plan);
	};
	auth.onResult(async () => {
		auth.driver.finish();
	});
	try {
		await runtime.attach(
			{ id: opened.plan.id, plan: opened.plan, members: new Map() } as Room,
			opened.plan,
			false,
		);
		runtime.bind(auth.context);
		await runtime.jobs(opened.plan)!.idle();
		expect(auth.driver.starts()).toBe(0);
		expect(runtime.jobs(opened.plan)!.jobs()[0]!.status).toBe("pending");
		await opened.storage.channels.claimAgentOwner(opened.plan.id, auth.sessionId, new Date());
		await auth.context.ownerAvailable();
		await runtime.jobs(opened.plan)!.idle();
		expect(auth.driver.starts()).toBe(1);
		expect(runtime.jobs(opened.plan)!.jobs()[0]!.status).toBe("done");
		expect(PlanRoom.project(opened.plan.document)).toContain("Offline operation is required.");
		expect(opened.plan.records.get(id)!.owner).toBe("ana");
		expect(errors).toEqual([]);
	} finally {
		auth.revokeAll();
		await runtime.stop(opened.plan);
	}
});
