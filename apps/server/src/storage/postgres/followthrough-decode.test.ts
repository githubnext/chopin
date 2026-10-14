import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { PostgresFollowthroughStore } from "./followthrough";

function store(context: unknown) {
	let row = {
		id: "a".repeat(64),
		channel_id: "parent",
		child_id: "child",
		kind: "research",
		source_id: "request",
		result_key: "answer",
		status: "running",
		revision: 1,
		attempts: 1,
		created_at: new Date(),
		updated_at: new Date(),
		reason: null,
		context,
		attempt_token: "attempt",
	};
	let sql = (async () => [row]) as unknown as SQL;
	return new PostgresFollowthroughStore(sql, async () => {});
}

test("normalizes PostgreSQL's serialized JSON context to the provider-neutral receipt", async () => {
	let context = { planRevision: 3, sourceHash: "hash" };
	let value = await store(JSON.stringify(context)).get("parent", "a".repeat(64));
	expect(value?.context).toEqual(context);
});

test("decodes an already parsed context without sharing the driver object", async () => {
	let context = { planRevision: 3, sourceHash: "hash" };
	let value = await store(context).get("parent", "a".repeat(64));
	expect(value?.context).toEqual(context);
	context.sourceHash = "external mutation";
	expect(value?.context?.sourceHash).toBe("hash");
});

test("rejects corrupt persisted context rather than returning an invalid claim", async () => {
	for (
		let context of ["{", "null", "[]", { planRevision: -1, sourceHash: "hash" }, {
			planRevision: 1,
			sourceHash: 7,
		}]
	) {
		await expect(store(context).get("parent", "a".repeat(64)))
			.rejects.toMatchObject({ failure: "corrupt" });
	}
});

test("a receipt without claim context omits the optional field", async () => {
	expect((await store(null).get("parent", "a".repeat(64)))?.context).toBeUndefined();
});
