import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { opened, job, call } = fixture;

test("failed placement persistence leaves no live move or publication", async () => {
	let context = await opened();
	job(context.plan, context.id);
	let before = room.project(context.plan.document);
	let broadcasts = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("storage unavailable");
	};
	context.backend.fatal = () => {};
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(
			await call(context, {
				revision: context.plan.revision,
				id: context.id,
				place_after: { index: 0, digest: room.digests(context.plan.document)[0] },
			}),
		).toBe("Error: storage unavailable");
	} finally {
		errors.mockRestore();
		context.storage.collaboration.commit = original;
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.broadcasts).toHaveLength(broadcasts);
	expect(context.plan.chat.jobOutput).toBeUndefined();
});
