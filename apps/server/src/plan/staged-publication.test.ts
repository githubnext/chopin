import { expect, spyOn, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as room from "./room";
import * as Service from "./service";
import { staged } from "./staged-publication.test-fixtures";

test("staged document and receipts stay private until their fenced commit succeeds", async () => {
	let context = await openPlan("# Before\n");
	let { plan, storage, server, broadcasts } = context;
	let { candidate, mutation } = await staged(plan, "# After\n");
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = storage.collaboration.commit.bind(storage.collaboration);
	let pending = spyOn(storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	});
	try {
		let publishing = Service.exclusive(
			plan,
			() => Service.publishStaged(plan, server, plan.id, candidate, mutation),
		);
		await entered.promise;
		expect(room.project(plan.document)).toBe("# Before\n");
		expect(plan.conversationPlanEffects).toEqual([]);
		expect(broadcasts).toEqual([]);
		let saved = await storage.collaboration.load(plan.id, new Date());
		expect(saved?.sidecar).not.toHaveProperty("conversationPlanEffects");
		release.resolve();
		await publishing;
		expect(room.project(plan.document)).toBe("# After\n");
		expect(plan.conversationPlanEffects).toEqual(["heading:document:m1"]);
		expect(broadcasts.map(frame => frame.kind)).toEqual(["plan:update"]);
		await Service.close(plan);
		let reopened = await Service.open(plan.id, context.backend, server);
		expect(room.project(reopened.document)).toBe("# After\n");
		expect(reopened.conversationPlanEffects).toEqual(["heading:document:m1"]);
		await Service.close(reopened);
	} finally {
		release.resolve();
		pending.mockRestore();
		candidate.document.doc.destroy();
	}
});

test("failed staged commit leaves live and reopened document and receipts unchanged", async () => {
	let context = await openPlan("# Before\n");
	let { plan, server, storage, broadcasts } = context;
	let { candidate, mutation } = await staged(plan, "# After\n");
	let failing = spyOn(storage.collaboration, "commit").mockRejectedValue(new Error("disk full"));
	try {
		await expect(
			Service.exclusive(
				plan,
				() => Service.publishStaged(plan, server, plan.id, candidate, mutation),
			),
		).rejects.toThrow("disk full");
		expect(room.project(plan.document)).toBe("# Before\n");
		expect(plan.revision).toBe(0);
		expect(plan.document.seq).toBe(0);
		expect(plan.conversationPlanEffects).toEqual([]);
		expect(broadcasts).toEqual([]);
	} finally {
		failing.mockRestore();
		candidate.document.doc.destroy();
	}
	await Service.close(plan);
	let reopened = await Service.open(plan.id, context.backend, server);
	expect(room.project(reopened.document)).toBe("# Before\n");
	expect(reopened.conversationPlanEffects).toEqual([]);
	await Service.close(reopened);
});
