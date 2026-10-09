import { expect, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as Plan from "../plan/service";
import { implementationGraphs } from "./plan-graphs";
import { pickBuild, queueBuild, reportBuild } from "./builds";

let task = {
	id: "first",
	title: "First task",
	context: "Launcher tracer",
	goal: "Prove the handoff",
	acceptance: ["Starts locally", "Reports to Chopin"],
	dependsOn: [],
};
let checkout = { repository: "owner/repository", branch: "main", commit: "a".repeat(40) };

async function prepared() {
	let context = await openPlan("# Settled plan\n");
	await implementationGraphs().revise(context.plan, {
		planRevision: 0,
		graphRevision: 0,
		operations: [{ op: "add", task }],
	});
	return context;
}

test("approval queues the reviewed graph once and pickup survives reopening", async () => {
	let { plan, backend, server } = await prepared();
	let input = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
		user: "U_test",
		connectionId: "laptop",
		repositoryId: "R_test",
		checkout,
	};
	let first = await queueBuild(plan, input);
	expect(first.state).toBe("queued");
	expect(await queueBuild(plan, input)).toEqual(first);
	expect(await pickBuild(plan, "U_other", "laptop")).toBeUndefined();
	expect(await pickBuild(plan, "U_test", "other")).toBeUndefined();
	expect((await pickBuild(plan, "U_test", "laptop"))?.state).toBe("starting");
	expect(await pickBuild(plan, "U_test", "laptop")).toBeUndefined();
	let id = plan.id;
	await Plan.close(plan);
	let reopened = await Plan.open(id, backend, server);
	expect(reopened.builds[0].id).toBe(first.id);
	expect(await pickBuild(reopened, "U_test", "laptop")).toBeUndefined();
	await Plan.close(reopened);
});

test("stale graph approval and unresolved planning decisions cannot queue a build", async () => {
	let { plan } = await prepared();
	let input = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 2,
		user: "U_test",
		connectionId: "laptop",
		repositoryId: "R_test",
		checkout,
	};
	await expect(queueBuild(plan, input)).rejects.toThrow("reviewed graph has changed");
	plan.records.set("open", { id: "open", status: "open" } as never);
	await expect(queueBuild(plan, { ...input, graphRevision: 1 }))
		.rejects.toThrow("unanswered questionnaires");
	expect(plan.graph?.versions[0].state).toBe("draft");
	expect(plan.builds).toEqual([]);
	plan.records.clear();
	await Plan.close(plan);
});

test("a failed durable commit publishes neither approval nor a build", async () => {
	let { plan, storage } = await prepared();
	let frames: unknown[] = [];
	plan.server = {
		publish: (_topic: string, frame: string) => frames.push(JSON.parse(frame)),
	} as never;
	let commit = storage.collaboration.commit;
	storage.collaboration.commit = async () => {
		throw new Error("offline");
	};
	await expect(
		queueBuild(plan, {
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
			user: "U_test",
			connectionId: "laptop",
			repositoryId: "R_test",
			checkout,
		}),
	)
		.rejects.toThrow("offline");
	expect(plan.graph?.versions[0].state).toBe("draft");
	expect(plan.builds).toEqual([]);
	expect(frames).toEqual([]);
	storage.collaboration.commit = commit;
	await Plan.close(plan);
});

test("failed pickup requires an explicit idempotent retry of the reviewed build", async () => {
	let { plan } = await prepared();
	let input = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
		user: "U_test",
		connectionId: "laptop",
		repositoryId: "R_test",
		checkout,
	};
	try {
		let first = await queueBuild(plan, input);
		await pickBuild(plan, input.user, input.connectionId);
		await reportBuild(plan, input.user, input.connectionId, first.id, {
			state: "failed",
			error: "Agent could not start",
		});
		expect(Plan.implementationActive(plan)).toBe(false);
		expect((await queueBuild(plan, input)).id).toBe(first.id);
		let retry = { ...input, retryOf: first.id };
		let second = await queueBuild(plan, retry);
		expect(second.id).not.toBe(first.id);
		expect(second.retryOf).toBe(first.id);
		expect((await queueBuild(plan, retry)).id).toBe(second.id);
		expect(plan.builds).toHaveLength(2);
		expect(Plan.implementationActive(plan)).toBe(true);
	} finally {
		await Plan.close(plan);
	}
});

test("a duplicate review cannot silently select another owner or checkout", async () => {
	let { plan } = await prepared();
	let input = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
		user: "U_test",
		connectionId: "laptop",
		repositoryId: "R_test",
		checkout,
	};
	try {
		let first = await queueBuild(plan, input);
		await expect(queueBuild(plan, { ...input, user: "other", connectionId: "other" }))
			.rejects.toThrow("review the existing build");
		await expect(queueBuild(plan, { ...input, checkout: { ...checkout, commit: "b".repeat(40) } }))
			.rejects.toThrow("review the existing build");
		await expect(queueBuild(plan, { ...input, retryOf: first.id }))
			.rejects.toThrow("review the existing build");
		expect(plan.builds).toHaveLength(1);
	} finally {
		await Plan.close(plan);
	}
});
