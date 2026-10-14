import { afterEach, expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { reconcile } from "./reconcile";
import { MAX_PASSAGES } from "./state";
import { clientEdit, fixture, request } from "./provenance.test-fixtures";

let contexts: Awaited<ReturnType<typeof fixture>>[] = [];
async function opened() {
	let context = await fixture();
	contexts.push(context);
	return context;
}
afterEach(async () => {
	for (let context of contexts) await Service.close(context.plan);
	contexts = [];
});

test("a scoped completion replaces its passage and appends bounded ordinary blocks", async () => {
	let { plan, broadcasts } = await opened();
	let input = request(plan);
	input.changes.push(
		{ id: null, markdown: "## Working approach", sourceIds: ["m2"] },
		{
			id: null,
			markdown: "- Compare the current names.\n- Try one clearer label.",
			sourceIds: ["m2"],
		},
	);
	expect((await reconcile(plan, input, () => true)).status).toBe("applied");
	expect(room.project(plan.document)).toContain("Human context.");
	expect(room.project(plan.document)).toContain("A more useful draft.");
	expect(plan.documentDevelopment!.passages).toHaveLength(3);
	expect(plan.documentDevelopment!.passages.every(item => item.status === "generated")).toBe(true);
	expect(plan.documentDevelopment!.lastJobId).toBe("job-1");
	expect(broadcasts.findIndex(frame => frame.kind === "plan:update")).toBeLessThan(
		broadcasts.findIndex(frame => frame.kind === "plan:changes"),
	);
});

test("unrelated concurrent human changes survive a scoped completion", async () => {
	let { plan } = await opened();
	let input = request(plan);
	await clientEdit(plan, { index: 2, text: "Another person has added context." });
	expect((await reconcile(plan, input, () => true)).status).toBe("applied");
	expect(room.project(plan.document)).toContain("Another person has added context.");
});

test("an admitted but not yet committed human edit is drained before reconciliation", async () => {
	let { plan } = await opened();
	let input = request(plan);
	await clientEdit(plan, { index: 1, text: "The person is changing this." }, false);
	expect(plan.queue.length).toBe(1);
	expect((await reconcile(plan, input, () => true)).status).toBe("stale");
	expect(room.project(plan.document)).toContain("The person is changing this.");
	expect(plan.documentDevelopment!.lastJobId).toBeUndefined();
});

test("a target replaced by another completion cannot accept its older baseline", async () => {
	let { plan } = await opened();
	let old = request(plan, { jobId: "old", messageId: "m3" });
	await reconcile(plan, request(plan), () => true);
	expect((await reconcile(plan, old, () => true)).status).toBe("stale");
});

test("changed conversation or decisions are checked again after staging", async () => {
	let { plan, broadcasts } = await opened();
	let before = room.project(plan.document);
	let checks = 0;
	expect((await reconcile(plan, request(plan), () => ++checks === 1)).status).toBe("stale");
	expect(room.project(plan.document)).toBe(before);
	expect(broadcasts).toEqual([]);
});

test("title, projections, code and multiple top-level blocks never enter this write path", async () => {
	let { plan } = await opened();
	let before = room.project(plan.document);
	for (
		let markdown of ["# A title", '<Decision id="x" />', "```ts\nlet x = 1;\n```", "One.\n\nTwo."]
	) {
		let input = request(plan, { changes: [{ id: null, markdown, sourceIds: ["m2"] }] });
		await expect(reconcile(plan, input, () => true)).rejects.toThrow();
	}
	expect(room.project(plan.document)).toBe(before);
});

test("unknown targets, duplicate targets and invented evidence reject the entire patch", async () => {
	let { plan } = await opened();
	for (
		let input of [
			request(plan, { removals: ["unknown"] }),
			request(plan, { removals: ["passage-1"] }),
			request(plan, { changes: [{ id: null, markdown: "A proposal.", sourceIds: ["invented"] }] }),
		]
	) await expect(reconcile(plan, input, () => true)).rejects.toThrow();
	expect(room.project(plan.document)).toContain("A draft observation.");
});

test("unchanged output stores its receipt without changing document revision or broadcasting a delta", async () => {
	let { plan, broadcasts } = await opened();
	let revision = plan.revision;
	let input = request(plan, {
		changes: [{ id: "passage-1", markdown: "A draft observation.", sourceIds: ["m2"] }],
	});
	expect((await reconcile(plan, input, () => true)).status).toBe("unchanged");
	expect(plan.revision).toBe(revision);
	expect(plan.documentDevelopment!.lastMessageId).toBe("m2");
	expect(broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
	expect((await reconcile(plan, input, () => true)).status).toBe("repeated");
});

test("empty output is acknowledged once and repeated completion never appends again", async () => {
	let { plan } = await opened();
	let empty = request(plan, { changes: [] });
	expect((await reconcile(plan, empty, () => true)).status).toBe("unchanged");
	let addition = request(plan, {
		jobId: "job-2",
		messageId: "m3",
		changes: [{ id: null, markdown: "One small experiment.", sourceIds: ["m2"] }],
	});
	await reconcile(plan, addition, () => true);
	let source = room.project(plan.document);
	expect((await reconcile(plan, addition, () => true)).status).toBe("repeated");
	expect(room.project(plan.document)).toBe(source);
});

test("implementation and paused documents refuse automatic changes", async () => {
	let { plan } = await opened();
	plan.claiming = true;
	expect((await reconcile(plan, request(plan), () => true)).status).toBe("blocked");
	plan.claiming = false;
	plan.documentDevelopment!.paused = true;
	expect((await reconcile(plan, request(plan), () => true)).status).toBe("blocked");
});

test("failed publication leaves source, receipt and ownership unchanged", async () => {
	let { plan, storage, broadcasts } = await opened();
	let source = room.project(plan.document);
	let state = structuredClone(plan.documentDevelopment);
	let commit = spyOn(storage.collaboration, "commit").mockRejectedValue(new Error("disk full"));
	try {
		await expect(reconcile(plan, request(plan), () => true)).rejects.toThrow("disk full");
		expect(room.project(plan.document)).toBe(source);
		expect(plan.documentDevelopment).toEqual(state);
		expect(broadcasts).toEqual([]);
	} finally {
		commit.mockRestore();
	}
});

test("receipt and generated anchors survive restart and prevent a second application", async () => {
	let context = await opened();
	let input = request(context.plan);
	await reconcile(context.plan, input, () => true);
	await Service.close(context.plan);
	context.plan = await Service.open(context.plan.id, context.backend, context.server);
	expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("generated");
	expect((await reconcile(context.plan, input, () => true)).status).toBe("repeated");
	expect(room.project(context.plan.document)).toContain("A more useful draft.");
});

test("retained passage capacity is terminal while replacements remain possible", async () => {
	let { plan } = await opened();
	let owned = plan.documentDevelopment!.passages[0]!;
	plan.documentDevelopment!.passages.push(...Array.from({ length: MAX_PASSAGES - 1 }, (_, i) => ({
		...owned,
		id: `retained-${i}`,
		status: "orphaned" as const,
	})));
	let addition = request(plan, {
		changes: [{ id: null, markdown: "An extra proposal.", sourceIds: ["m2"] }],
	});
	expect((await reconcile(plan, addition, () => true)).status).toBe("capacity");
	expect(plan.documentDevelopment!.lastJobId).toBeUndefined();
	expect((await reconcile(plan, request(plan), () => true)).status).toBe("applied");
});

test("generated source capacity is terminal without consuming or publishing the artifact", async () => {
	let source = "# Notes\n\n"
		+ Array.from({ length: 10 }, (_, i) => `${i} ${"x".repeat(1185)}.\n\n`).join("");
	let context = await fixture(source);
	contexts.push(context);
	let { plan, broadcasts } = context;
	let hashes = room.digests(plan.document);
	let owned = plan.documentDevelopment!.passages[0]!;
	plan.documentDevelopment!.passages = hashes.slice(1).map((hash, i) => ({
		...owned,
		id: `passage-${i + 1}`,
		anchor: room.anchorAt(plan.document, i + 1, hash),
		generatedDigest: hash,
	}));
	let before = room.project(plan.document);
	let addition = request(plan, {
		changes: [{ id: null, markdown: "x".repeat(200), sourceIds: ["m2"] }],
	});
	expect((await reconcile(plan, addition, () => true)).status).toBe("capacity");
	expect(room.project(plan.document)).toBe(before);
	expect(plan.documentDevelopment!.lastJobId).toBeUndefined();
	expect(broadcasts).toEqual([]);
});
