import { expect, it, spyOn } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";

it("persists a server-authored Research card once before broadcasting", async () => {
	let context = await hosted();
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	try {
		let id = ulid();
		await Service.placeResearchReference(plan, id);
		expect(Service.source(plan)).toContain(`<Research id="${id}" />`);
		expect(context.frames.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
		let stored = await context.storage.collaboration.load(context.channel.id, context.now);
		if (!stored) throw new Error("document is missing");
		expect((await Service.readStored(stored)).source).toContain(`<Research id="${id}" />`);
		await Service.placeResearchReference(plan, id);
		expect(context.frames.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
	} finally {
		await Service.close(plan);
	}
});

it("does not expose a Research card when its document commit fails", async () => {
	let context = await hosted();
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	let commit = spyOn(context.storage.collaboration, "commit").mockImplementation(async () => {
		throw new Error("document commit failed");
	});
	try {
		await expect(Service.placeResearchReference(plan, ulid()))
			.rejects.toThrow("document commit failed");
		expect(Service.source(plan)).not.toContain("<Research");
		expect(context.frames.filter(frame => frame.kind === "plan:update")).toEqual([]);
	} finally {
		commit.mockRestore();
		await Service.close(plan);
	}
});
