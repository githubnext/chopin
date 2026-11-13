import { expect, test } from "bun:test";
import { applyAnchors } from "../agent/document-ops";
import { createDecisionProseFixture } from "../agent/decision-prose.test-fixtures";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "./service";
import type { DocumentRoom } from "../agent/tools";

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => contexts = value);
contexts = fixture.contexts;

let origins: Array<"conversation" | "planner"> = ["conversation", "planner"];

const TABLE = "| Option | Cost |\n| - | - |\n| GitHub Apps | Low |";

async function setup(
	origin: typeof origins[number],
	{ prose = [1], orphaned = true, table = false } = {},
) {
	let context = await fixture.opened(
		`Original context.\n\nCurrent decision prose.\n\n${
			table ? `${TABLE}\n\n` : ""
		}${fixture.WIDGET}`,
	);
	let { plan, server } = context;
	let record = plan.records.get(fixture.CARD)!;
	record.origin = origin;
	if (origin === "planner") record.childId = "decision-report";
	let lost = {
		...Room.anchorAt(plan.document, 0, Room.digests(plan.document)[0]!),
		orphaned: true as const,
	};
	record.prose = prose.map(index => ({
		...Room.anchorAt(plan.document, index, Room.digests(plan.document)[index]!),
		...(orphaned ? { orphaned: true } : {}),
	}));
	record.anchors = {
		widget: fixture.CARD,
		questions: { [fixture.QUESTION]: { anchors: [lost], pending: true, reason: "orphaned" } },
	};
	await Service.persist(plan);
	let target: DocumentRoom = {
		id: plan.id,
		plan,
		server,
		exclusive: action => Service.exclusive(plan, action),
		publish: mutation => Service.publish(plan, server, plan.id, mutation),
		persist: () => Service.persist(plan),
		anchors: () => Service.anchors(plan, server, plan.id),
		changes() {},
	};
	let args = {
		revision: plan.revision,
		anchors: [{
			widget: fixture.CARD,
			question: fixture.QUESTION,
			blocks: [{ index: 1, digest: Room.digests(plan.document)[1]! }],
		}],
	};
	return { ...context, target, args };
}

async function restart(context: Awaited<ReturnType<typeof setup>>) {
	await Service.close(context.plan);
	contexts = contexts.filter(value => value.plan !== context.plan);
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	contexts.push({ ...context, plan });
	return plan;
}

test.each(origins)(
	"explicit %s prose reanchoring commits before publication and survives restart",
	async origin => {
		let context = await setup(origin);
		let { plan, target, args } = context;
		let before = structuredClone(plan.records.get(fixture.CARD)!);
		let source = Room.project(plan.document);
		let broadcasts = context.broadcasts.length;
		let commit = context.storage.collaboration.commit;
		let release!: () => void;
		let entered!: () => void;
		let gate = new Promise<void>(resolve => release = resolve);
		let committing = new Promise<void>(resolve => entered = resolve);
		context.storage.collaboration.commit = async input => {
			entered();
			await gate;
			return commit(input);
		};
		let pending = applyAnchors(target, args);
		await committing;
		try {
			expect(plan.records.get(fixture.CARD)).toEqual(before);
			expect(context.broadcasts).toHaveLength(broadcasts);
		} finally {
			release();
			context.storage.collaboration.commit = commit;
		}
		expect(await pending).toMatchObject({ ok: true });
		let record = plan.records.get(fixture.CARD)!;
		expect(record).toEqual({ ...before, prose: record.prose, anchors: record.anchors });
		expect(record.prose).toHaveLength(1);
		expect(Questions.meta(plan, record)).toMatchObject({ hasProse: true, proseOrphaned: false });
		expect(Room.matchesAnchor(plan.document, record.prose![0]!, 1)).toBe(true);
		expect(record.choices).toEqual(before.choices);
		expect(record.owner).toBe(before.owner);
		expect(record.decidedAt).toBe(before.decidedAt);
		expect(Room.project(plan.document)).toBe(source);
		let restored = await restart(context);
		expect(restored.records.get(fixture.CARD)).toEqual(record);
		expect(Questions.meta(restored, restored.records.get(fixture.CARD)!))
			.toMatchObject({ hasProse: true, proseOrphaned: false });
		expect(Room.matchesAnchor(restored.document, restored.records.get(fixture.CARD)!.prose![0]!, 1))
			.toBe(true);
	},
);

test.each(origins)(
	"an explicit empty %s review clears orphaned prose without becoming pending or missing",
	async origin => {
		let context = await setup(origin);
		let before = structuredClone(context.plan.records.get(fixture.CARD)!);
		context.args.anchors[0]!.blocks = [];
		expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: true });
		let restored = await restart(context);
		let record = restored.records.get(fixture.CARD)!;
		expect(record).toEqual({ ...before, prose: [], anchors: record.anchors });
		expect(record.prose).toEqual([]);
		expect(record.anchors?.questions[fixture.QUESTION]).toEqual({ anchors: [], pending: false });
		expect(Questions.prose(restored)).toEqual([]);
		expect(Questions.meta(restored, record)).toMatchObject({
			hasProse: false,
			proseOrphaned: false,
		});
	},
);

test.each(origins)(
	"a %s decision without written prose keeps ordinary multi-block relationships",
	async origin => {
		let context = await setup(origin);
		delete context.plan.records.get(fixture.CARD)!.prose;
		await Service.persist(context.plan);
		context.args.anchors[0]!.blocks = [0, 1].map(index => ({
			index,
			digest: Room.digests(context.plan.document)[index]!,
		}));
		expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: true });
		let restored = await restart(context);
		let record = restored.records.get(fixture.CARD)!;
		expect(record.prose).toBeUndefined();
		expect(record.anchors?.questions[fixture.QUESTION].anchors).toHaveLength(2);
	},
);

test.each(
	origins.flatMap(origin =>
		(["stale", "digest", "nonparagraph", "multiple"] as const).map(kind => [origin, kind] as const)
	),
)(
	"a %s decision's %s reanchor preserves the existing orphaned state",
	async (origin, kind) => {
		let context = await setup(origin);
		let before = structuredClone(context.plan.records.get(fixture.CARD));
		let source = Room.project(context.plan.document);
		let broadcasts = context.broadcasts.length;
		if (kind === "stale") context.args.revision--;
		if (kind === "digest") context.args.anchors[0]!.blocks[0]!.digest = `sha256:${"0".repeat(64)}`;
		if (kind === "nonparagraph") {
			context.args.anchors[0]!.blocks = [{
				index: 2,
				digest: Room.digests(context.plan.document)[2]!,
			}];
		}
		if (kind === "multiple") {
			context.args.anchors[0]!.blocks.unshift({
				index: 0,
				digest: Room.digests(context.plan.document)[0]!,
			});
		}
		expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: false });
		expect(context.plan.records.get(fixture.CARD)).toEqual(before);
		expect(Room.project(context.plan.document)).toBe(source);
		expect(context.broadcasts).toHaveLength(broadcasts);
		let restored = await restart(context);
		expect(restored.records.get(fixture.CARD)).toEqual(before);
	},
);

test.each(origins)(
	"a rejected %s commit leaves live and durable prose orphaned and publishes nothing",
	async origin => {
		let context = await setup(origin);
		let before = structuredClone(context.plan.records.get(fixture.CARD));
		let source = Room.project(context.plan.document);
		let broadcasts = context.broadcasts.length;
		let commit = context.storage.collaboration.commit;
		context.storage.collaboration.commit = async () => {
			throw new Error("reanchor commit failed");
		};
		try {
			await expect(applyAnchors(context.target, context.args)).rejects.toThrow(
				"reanchor commit failed",
			);
		} finally {
			context.storage.collaboration.commit = commit;
		}
		expect(context.plan.records.get(fixture.CARD)).toEqual(before);
		expect(Room.project(context.plan.document)).toBe(source);
		expect(context.broadcasts).toHaveLength(broadcasts);
		let restored = await restart(context);
		expect(restored.records.get(fixture.CARD)).toEqual(before);
	},
);

function blocks(context: Awaited<ReturnType<typeof setup>>, indices: number[]) {
	return indices.map(index => ({ index, digest: Room.digests(context.plan.document)[index]! }));
}

test.each(origins.flatMap(origin => [[origin, [0, 1]], [origin, []]] as const))(
	"a %s decision with live prose keeps it when reviewed with blocks %p",
	async (origin, indices) => {
		let context = await setup(origin, { orphaned: false });
		let before = structuredClone(context.plan.records.get(fixture.CARD)!.prose);
		context.args.anchors[0]!.blocks = blocks(context, [...indices]);
		expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: true });
		let restored = await restart(context);
		let record = restored.records.get(fixture.CARD)!;
		// Placing the card may move the prose paragraph; it must still name that paragraph.
		let index = Room.digests(restored.document).indexOf(before![0]!.digest);
		expect(record.prose).toHaveLength(1);
		expect(record.prose![0]).toMatchObject({ digest: before![0]!.digest });
		expect(record.prose![0]!.orphaned).toBeUndefined();
		expect(Room.matchesAnchor(restored.document, record.prose![0]!, index)).toBe(true);
		expect(record.anchors?.questions[fixture.QUESTION].anchors).toHaveLength(indices.length);
		expect(Questions.meta(restored, record)).toMatchObject({
			hasProse: true,
			proseOrphaned: false,
		});
	},
);

test.each([false, true])(
	"a dropped follow-up's paragraph and table prose is not rejected when orphaned is %p",
	async orphaned => {
		let context = await setup("planner", { prose: [1, 2], orphaned, table: true });
		let before = structuredClone(context.plan.records.get(fixture.CARD)!.prose);
		context.args.anchors[0]!.blocks = blocks(context, [1, 2]);
		expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: true });
		let restored = await restart(context);
		let record = restored.records.get(fixture.CARD)!;
		if (!orphaned) expect(record.prose).toEqual(before);
		expect(record.prose).toHaveLength(2);
		expect(record.prose!.every(anchor => !anchor.orphaned)).toBe(true);
		expect(Room.matchesAnchor(restored.document, record.prose![0]!, 1)).toBe(true);
		expect(Room.matchesAnchor(restored.document, record.prose![1]!, 2)).toBe(true);
	},
);

test("a dropped follow-up's lost passage takes the table after its named paragraph", async () => {
	let context = await setup("planner", { prose: [1, 2], table: true });
	context.args.anchors[0]!.blocks = blocks(context, [1]);
	expect(await applyAnchors(context.target, context.args)).toMatchObject({ ok: true });
	let record = (await restart(context)).records.get(fixture.CARD)!;
	expect(record.prose).toHaveLength(2);
	expect(record.prose!.every(anchor => !anchor.orphaned)).toBe(true);
});

test("a dropped follow-up's lost passage must begin with a paragraph", async () => {
	let context = await setup("planner", { prose: [1, 2], table: true });
	let before = structuredClone(context.plan.records.get(fixture.CARD));
	context.args.anchors[0]!.blocks = blocks(context, [2]);
	expect(await applyAnchors(context.target, context.args)).toMatchObject({
		ok: false,
		errors: ["Decision prose must name one bounded passage or no blocks."],
	});
	expect((await restart(context)).records.get(fixture.CARD)).toEqual(before);
});
