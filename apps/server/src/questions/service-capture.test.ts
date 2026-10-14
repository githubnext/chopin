import { expect, spyOn, test } from "bun:test";
import { capture } from "./service-capture";
import { retitle } from "./card-retitle";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";

let input = {
	key: "onboarding-1",
	question: "How should onboarding work?",
	description: "Help first-time collaborators understand decisions.",
};

test("a human captures an open decision without options, idempotently across restart", async () => {
	let context = await openPlan();
	try {
		let [first, repeated] = await Promise.all([
			capture(context.plan, context.server, context.plan.id, input, { human: "ana" }),
			capture(context.plan, context.server, context.plan.id, input, { human: "ana" }),
		]);
		expect(repeated).toEqual(first);
		expect(context.plan.records.size).toBe(1);
		expect(context.plan.records.get(first)).toMatchObject({
			status: "open",
			origin: "human",
			owner: "ana",
			editors: ["ana"],
			definition: { questions: [{ response: "text", options: [], question: input.question }] },
		});
		expect(Room.project(context.plan.document)).toContain('response="text"');
		await Plan.close(context.plan);
		context.plan = await Plan.open(context.plan.id, context.backend, context.server);
		expect(await capture(context.plan, context.server, context.plan.id, input, { human: "ana" }))
			.toBe(first);
		expect(context.plan.questions.open.size).toBe(1);
		await retitle(
			context.plan,
			context.server,
			context.plan.id,
			first,
			"How should first-time setup work?",
		);
		expect(await capture(context.plan, context.server, context.plan.id, input, { human: "ana" }))
			.toBe(first);
		expect(context.plan.records.get(first)?.definition.questions[0]?.question)
			.toBe("How should first-time setup work?");
	} finally {
		await Plan.close(context.plan);
	}
});

test("creation publishes neither a card nor a shared draft before its durable commit", async () => {
	let context = await openPlan();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = context.storage.collaboration.commit.bind(context.storage.collaboration);
	let held = spyOn(context.storage.collaboration, "commit").mockImplementation(async value => {
		entered.resolve();
		await release.promise;
		return commit(value);
	});
	try {
		let pending = capture(context.plan, context.server, context.plan.id, input, { human: "ana" });
		await entered.promise;
		expect(context.plan.records.size).toBe(0);
		expect(context.plan.questions.open.size).toBe(0);
		expect(context.broadcasts).toEqual([]);
		release.resolve();
		let id = await pending;
		expect(context.plan.records.has(id)).toBe(true);
		expect(context.broadcasts.map(frame => frame.kind)).toContain("question:asked");
	} finally {
		release.resolve();
		held.mockRestore();
		await Plan.close(context.plan);
	}
});

test("failed creation is retryable without leaving a live decision", async () => {
	let context = await openPlan();
	let held = spyOn(context.storage.collaboration, "commit")
		.mockRejectedValueOnce(new Error("storage unavailable"));
	try {
		await expect(capture(context.plan, context.server, context.plan.id, input, { human: "ana" }))
			.rejects.toThrow("storage unavailable");
		expect(context.plan.records.size).toBe(0);
		expect(context.broadcasts).toEqual([]);
		let id = await capture(context.plan, context.server, context.plan.id, input, { human: "ana" });
		expect(context.plan.records.has(id)).toBe(true);
	} finally {
		held.mockRestore();
		await Plan.close(context.plan);
	}
});

test("Planner capture requires a current revision and does not resolve the decision", async () => {
	let context = await openPlan();
	try {
		await expect(capture(context.plan, context.server, context.plan.id, input, { revision: 99 }))
			.rejects.toThrow("changed");
		let id = await capture(context.plan, context.server, context.plan.id, input, { revision: 0 });
		expect(context.plan.records.get(id)).toMatchObject({ status: "open", origin: "planner" });
		expect(context.plan.records.get(id)?.answers).toBeUndefined();
	} finally {
		await Plan.close(context.plan);
	}
});
