import { expect, test } from "bun:test";
import { close, open } from "../plan/service";
import { openPlan } from "../testing/plan";
import { implementationGraphs } from "./plan-graphs";
import { implementationStatus } from "./notifications";

test("graph availability publishes after its durable commit and survives reopening", async () => {
	let context = await openPlan("# Task graph\n\nA settled document.\n");
	let { plan, broadcasts, storage } = context;
	expect(implementationStatus(plan).hasGraph).toBe(false);
	let commit = storage.collaboration.commit.bind(storage.collaboration);
	storage.collaboration.commit = async input => {
		expect(broadcasts.some(frame => frame.kind === "plan:implementation")).toBe(false);
		return commit(input);
	};
	let result = await implementationGraphs().revise(plan, {
		planRevision: plan.revision,
		graphRevision: 0,
		operations: [{
			op: "add",
			task: {
				id: "first",
				title: "First task",
				context: "The document",
				goal: "Implement it",
				acceptance: ["Works", "Verified"],
				dependsOn: [],
			},
		}],
	});
	expect(result.ok).toBe(true);
	expect(broadcasts.find(frame => frame.kind === "plan:implementation")).toMatchObject({
		hasGraph: true,
		locked: false,
	});
	storage.collaboration.commit = commit;
	await close(plan);
	let reopened = await open(context.channel.id, context.backend, context.server);
	expect(implementationStatus(reopened).hasGraph).toBe(true);
	await close(reopened);
});
