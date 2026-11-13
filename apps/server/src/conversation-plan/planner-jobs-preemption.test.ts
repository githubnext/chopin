/** A job that gave way to a person's turn waits, unspent, and runs again when it is woken. */
import { expect, test } from "bun:test";
import * as Jobs from "./jobs";
import { AT, harness } from "./planner-jobs.test-fixtures";

test("a preempted job goes back to pending with its attempts unspent, then completes when woken", async () => {
	let runs = 0;
	let h = harness(async () =>
		++runs === 1
			? { status: "preempted", reason: "A person asked the Planner." }
			: { status: "done", output: "{}" }
	);
	await h.service.enqueue({ kind: "heading", target: "document", trigger: "m1" });
	await h.service.idle();
	expect(runs).toBe(1);
	expect(h.service.jobs()).toMatchObject([{ status: "pending", attempts: 0 }]);
	expect(h.service.jobs()[0]).not.toHaveProperty("reason");
	expect(h.published.at(-1)).toEqual(["heading:document:m1:pending"]);

	// The end of the person's turn wakes the queue.
	h.service.wake();
	await h.service.idle();
	expect(runs).toBe(2);
	expect(h.service.jobs()).toMatchObject([{ status: "done", attempts: 1 }]);
});

test("a preempted job a newer request already replaces is skipped, so one waits for each thing", () => {
	let running = Jobs.start(
		Jobs.enqueue([], { kind: "heading", target: "document", trigger: "m1" }, AT),
		"heading:document:m1",
		AT,
	);
	let both = Jobs.enqueue(running, { kind: "heading", target: "document", trigger: "m2" }, AT);
	let settled = Jobs.settle(
		both,
		"heading:document:m1",
		{ status: "preempted", reason: "A person asked the Planner." },
		AT,
	);
	expect(settled.map(job => [job.id, job.status])).toEqual([
		["heading:document:m1", "skipped"],
		["heading:document:m2", "pending"],
	]);
	expect(settled[0]).toMatchObject({ reason: "A newer request replaced it.", attempts: 1 });
	// What is kept is still a valid queue.
	expect(Jobs.restore(settled)).toEqual(settled);
});
