import { expect, it, spyOn } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";

it("holds a Research card from both clients until its durable commit finishes", async () => {
	let context = await hosted();
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	let first: string[] = [];
	let second: string[] = [];
	let publish = spyOn(context.server, "publish").mockImplementation((_topic, value) => {
		first.push(String(value));
		second.push(String(value));
		return 0;
	});
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commitOriginal = context.storage.collaboration.commit;
	let commit = spyOn(context.storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return commitOriginal(input);
	});
	try {
		let placement = Service.placeResearchReference(plan, ulid());
		await entered.promise;
		expect(first).toEqual([]);
		expect(second).toEqual([]);
		release.resolve();
		await placement;
		expect(first).toHaveLength(1);
		expect(second).toEqual(first);
	} finally {
		commit.mockRestore();
		publish.mockRestore();
		await Service.close(plan);
	}
});

it("defers Research placement while implementation holds the document", async () => {
	let context = await hosted();
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	let id = ulid();
	try {
		plan.claiming = true;
		expect(await Service.placeResearchReference(plan, id)).toBe("deferred");
		expect(Service.source(plan)).not.toContain(`<Research id="${id}" />`);
		expect(context.frames.filter(frame => frame.kind === "plan:update")).toEqual([]);
		plan.claiming = false;
		expect(await Service.placeResearchReference(plan, id)).toBe("placed");
		expect(Service.source(plan)).toContain(`<Research id="${id}" />`);
		expect(context.frames.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
	} finally {
		plan.claiming = false;
		await Service.close(plan);
	}
});
