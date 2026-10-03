import { expect, it } from "bun:test";
import { $getRoot } from "lexical";
import * as Y from "yjs";

import * as room from "../plan/room";
import * as Service from "../plan/service";

import * as Prose from "./prose";
import { normalizeRecord } from "./records";
import * as Questions from "./service";
import type { Plan } from "@chopin/protocol";
import type { Plan as RoomPlan } from "../plan/service";

import { cardWithProse, peerFrames, subject } from "./prose.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
it("keeps distinct identical paragraphs across a same-history epoch rebuild", async () => {
	let { document, anchor } = await subject("# Title\n\nSame.\n\nSame.\n");
	try {
		let rebuilt = await room.rebuild(document);
		try {
			let [carried] = Prose.carry(rebuilt, [anchor], room.project(document));
			expect(carried?.orphaned).toBeUndefined();
			expect(carried?.epoch).toBe(rebuilt.epoch);
			expect(room.matchesAnchor(rebuilt, carried!, 2)).toBe(true);
		} finally {
			rebuilt.doc.destroy();
		}
	} finally {
		document.doc.destroy();
	}
});

it("does not call absent prose orphaned", () => {
	expect(Prose.orphaned(undefined)).toBe(false);
	expect(Prose.orphaned([])).toBe(false);
	let anchors: Plan.Anchor[] = [{
		epoch: "old",
		position: "AA==",
		digest: `sha256:${"0".repeat(64)}`,
		orphaned: true,
	}];
	expect(Prose.orphaned(anchors)).toBe(true);
});

it("restores only orphaned prose with a one-edit recovery hint", async () => {
	let context = await cardWithProse();
	try {
		let record = context.plan.records.get(context.id)!;
		let recoverable = {
			...context.anchor,
			orphaned: true as const,
			recoverOnNextEdit: true as const,
		};
		expect(normalizeRecord({ ...record, prose: [recoverable] }).prose).toEqual([recoverable]);
		expect(() =>
			normalizeRecord({
				...record,
				prose: [{ ...context.anchor, recoverOnNextEdit: true }],
			})
		).toThrow(/invalid question record/);
	} finally {
		await Service.close(context.plan);
	}
});

it("persists prose and exposes it in open and relationship snapshots", async () => {
	let context = await cardWithProse();
	let opened: RoomPlan | undefined = context.plan;
	try {
		expect(Questions.prose(context.plan)).toEqual([{
			widget: context.id,
			anchors: [context.anchor],
			orphaned: false,
		}]);
		expect(
			Object.values(Questions.anchors(context.plan)[0]!.questions).every(set =>
				set.anchors.length === 0
			),
		).toBe(true);
		expect(Questions.meta(context.plan, context.plan.records.get(context.id)!))
			.toMatchObject({ hasProse: true, proseOrphaned: false });

		let { ws, frames } = peerFrames();
		Service.greet(context.plan, ws, { kind: "plan:open", ts: 0, rid: "open" });
		expect(frames.at(-1)).toMatchObject({
			kind: "plan:open",
			prose: [{ widget: context.id, orphaned: false }],
		});
		Service.anchors(context.plan, context.server, context.channel.id);
		expect(context.broadcasts.at(-2)).toMatchObject({
			kind: "plan:anchors",
			prose: [{ widget: context.id, orphaned: false }],
		});
		expect(context.broadcasts.at(-1)).toMatchObject({
			kind: "question:meta",
			id: context.id,
			meta: { hasProse: true, proseOrphaned: false },
		});

		await Service.close(opened);
		opened = undefined;
		let restored = await Service.open(context.channel.id, context.backend, context.server);
		opened = restored;
		expect(Questions.prose(restored)).toMatchObject([{
			widget: context.id,
			orphaned: false,
		}]);
		expect(room.matchesAnchor(restored.document, restored.records.get(context.id)!.prose![0]!, 1))
			.toBe(true);
	} finally {
		if (opened) await Service.close(opened);
	}
});

it("publishes orphaned prose metadata only after a human deletion commits", async () => {
	let context = await cardWithProse("# Title\n\nSame.\n\nSame.\n", 2);
	let peer = await room.restore(
		context.plan.document.epoch,
		Y.encodeStateAsUpdate(context.plan.document.doc),
		room.project(context.plan.document),
		[],
	);
	try {
		let vector = Y.encodeStateVector(context.plan.document.doc);
		peer.editor.update(() => {
			$getRoot().getChildren()[2]!.remove();
		}, { discrete: true });
		await room.settle();
		let update = Y.encodeStateAsUpdate(peer.doc, vector);
		let original = context.storage.collaboration.commit;
		let release: (() => void) | undefined;
		let blocked = new Promise<void>(resolve => release = resolve);
		(context.storage.collaboration as { commit: typeof original }).commit = async input => {
			await blocked;
			return original(input);
		};
		let { ws } = peerFrames();
		let before = context.broadcasts.length;
		try {
			Service.submit(context.plan, ws, {
				kind: "plan:update",
				ts: 0,
				rid: "delete",
				id: "delete",
				epoch: context.plan.document.epoch,
				update: Buffer.from(update).toString("base64"),
			});
			await Bun.sleep(20);
			expect(
				context.broadcasts.slice(before).filter(frame =>
					frame.kind === "question:meta" || frame.kind === "plan:anchors"
				),
			).toEqual([]);
		} finally {
			release!();
			await context.plan.flushing;
			(context.storage.collaboration as { commit: typeof original }).commit = original;
		}
		expect(context.plan.records.get(context.id)?.prose?.[0]?.orphaned).toBe(true);
		expect(room.project(context.plan.document).split("Same.")).toHaveLength(2);
		expect(Questions.meta(context.plan, context.plan.records.get(context.id)!))
			.toMatchObject({ hasProse: false, proseOrphaned: true });
		expect(context.broadcasts.slice(before)).toEqual(expect.arrayContaining([
			expect.objectContaining({
				kind: "plan:anchors",
				prose: [{ widget: context.id, anchors: expect.any(Array), orphaned: true }],
			}),
			expect.objectContaining({
				kind: "question:meta",
				id: context.id,
				meta: expect.objectContaining({ hasProse: false, proseOrphaned: true }),
			}),
		]));
	} finally {
		peer.doc.destroy();
		await Service.close(context.plan);
	}
});
