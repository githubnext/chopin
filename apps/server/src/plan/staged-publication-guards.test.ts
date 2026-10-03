import { expect, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as room from "./room";
import * as Service from "./service";
import { staged } from "./staged-publication.test-fixtures";

test("staged source changes require their document mutation and respect active implementation", async () => {
	let { plan, server, broadcasts } = await openPlan("# Before\n");
	let { candidate, mutation } = await staged(plan, "# After\n");
	try {
		await expect(Service.publishStaged(plan, server, plan.id, candidate))
			.rejects.toThrow("staged document changed without a mutation");
		plan.claiming = true;
		await expect(Service.publishStaged(plan, server, plan.id, candidate, mutation))
			.rejects.toThrow("implementation is active");
		expect(room.project(plan.document)).toBe("# Before\n");
		expect(broadcasts).toEqual([]);
	} finally {
		plan.claiming = false;
		candidate.document.doc.destroy();
		await Service.close(plan);
	}
});

test("staged notification opt-out preserves the default durable document callback", async () => {
	let { plan, server } = await openPlan("# Before\n");
	let observed: string[] = [];
	plan.persistence.onDocumentPersisted = event => {
		observed.push(event.source);
	};
	let first = await staged(plan, "# First\n");
	let second: Awaited<ReturnType<typeof staged>> | undefined;
	try {
		await Service.exclusive(
			plan,
			() =>
				Service.publishStaged(plan, server, plan.id, first.candidate, first.mutation, {
					notifyDocumentPersisted: false,
				}),
		);
		expect(observed).toEqual([]);
		second = await staged(plan, "# Second\n");
		let next = second;
		await Service.exclusive(
			plan,
			() => Service.publishStaged(plan, server, plan.id, next.candidate, next.mutation),
		);
		expect(observed).toEqual(["# Second\n"]);
	} finally {
		first.candidate.document.doc.destroy();
		second?.candidate.document.doc.destroy();
		await Service.close(plan);
	}
});
