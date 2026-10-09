import { expect, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as Plan from "../plan/service";
import { implementationGraphs } from "./plan-graphs";
import { pickBuild, queueBuild } from "./builds";

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
	storage.collaboration.commit = commit;
	await Plan.close(plan);
});
