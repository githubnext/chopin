import { expect, it } from "bun:test";

import * as Y from "yjs";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";

import * as Questions from "./service";
import type { Plan } from "@chopin/protocol";
import type { Plan as RoomPlan } from "../plan/service";

import { cardWithProse } from "./prose.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
it("publishes orphaned metadata after a Planner edit's relationship snapshot", async () => {
	let context = await cardWithProse("# Title\n\nSame.\n\nSame.\n", 2);
	try {
		let outcome = edit.apply(context.plan, context.plan.revision, [{ op: "delete", index: 2 }]);
		if (!outcome.ok || !outcome.mutation) throw new Error("expected a paragraph deletion");
		Questions.rebase(context.plan);
		expect(Questions.prose(context.plan)[0]?.orphaned).toBe(true);
		expect(room.project(context.plan.document).split("Same.")).toHaveLength(2);
		let before = context.broadcasts.length;
		let original = context.storage.collaboration.commit;
		let release: (() => void) | undefined;
		let blocked = new Promise<void>(resolve => release = resolve);
		(context.storage.collaboration as { commit: typeof original }).commit = async input => {
			await blocked;
			return original(input);
		};
		try {
			let publishing = Service.publish(
				context.plan,
				context.server,
				context.channel.id,
				outcome.mutation,
			).then(() => Service.anchors(context.plan, context.server, context.channel.id));
			await Bun.sleep(10);
			expect(context.broadcasts).toHaveLength(before);
			release!();
			await publishing;
		} finally {
			release!();
			(context.storage.collaboration as { commit: typeof original }).commit = original;
		}
		expect(context.broadcasts.slice(before).map(frame => frame.kind)).toEqual([
			"plan:update",
			"plan:anchors",
			"question:meta",
		]);
		expect(context.broadcasts.at(-1)).toMatchObject({
			kind: "question:meta",
			id: context.id,
			meta: { hasProse: false, proseOrphaned: true },
		});
	} finally {
		await Service.close(context.plan);
	}
});

it("keeps the pre-edit source when a staged document deletes duplicate prose", async () => {
	let context = await cardWithProse("# Title\n\nSame.\n\nSame.\n", 2);
	let staged = await room.restore(
		context.plan.document.epoch,
		Y.encodeStateAsUpdate(context.plan.document.doc),
		room.project(context.plan.document),
		[],
	);
	staged.seq = context.plan.document.seq;
	try {
		let candidate = {
			...context.plan,
			document: staged,
			records: new Map(context.plan.records),
		} as RoomPlan;
		let outcome = edit.apply(candidate, candidate.revision, [{ op: "delete", index: 2 }]);
		if (!outcome.ok || !outcome.mutation) throw new Error("expected a paragraph deletion");
		Questions.rebase(candidate);
		expect(candidate.records.get(context.id)?.prose?.[0]?.orphaned).toBe(true);
		await Service.publishStaged(
			context.plan,
			context.server,
			context.channel.id,
			candidate,
			outcome.mutation,
		);
		expect(context.plan.records.get(context.id)?.prose?.[0]?.orphaned).toBe(true);
		let persisted = await context.storage.collaboration.load(context.channel.id, context.now);
		let sidecar = persisted?.sidecar as {
			questions: Array<{ id: string; prose?: Plan.Anchor[] }>;
		} | undefined;
		expect(sidecar?.questions.find(item => item.id === context.id)?.prose?.[0]?.orphaned)
			.toBe(true);
	} finally {
		staged.doc.destroy();
		await Service.close(context.plan);
	}
});

it("uses the pre-rewrite source when replacing a document with duplicate prose", async () => {
	let context = await cardWithProse("# Title\n\nSame.\n\nSame.\n", 2);
	try {
		let previous = room.project(context.plan.document);
		let next = previous.replace("Same.\n\nSame.\n", "Same.\n");
		let outcome = await Service.rewrite(context.plan, next, (source, revision) => ({
			idempotencyKey: "rewrite-prose",
			fingerprint: "rewrite-prose",
			fromRevision: context.plan.revision,
			client: { name: "test", version: "1" },
			document: { source, revision, title: "Title", url: "https://example.test" },
		}));
		expect(outcome.ok).toBe(true);
		expect(room.project(context.plan.document).split("Same.")).toHaveLength(2);
		expect(context.plan.records.get(context.id)?.prose?.[0]?.orphaned).toBe(true);
	} finally {
		await Service.close(context.plan);
	}
});

it("rebases a surviving prose anchor across an epoch change", async () => {
	let context = await cardWithProse();
	let old = context.plan.document;
	try {
		let rebuilt = await room.rebuild(old);
		context.plan.document = rebuilt;
		Questions.rebase(context.plan);
		let prose = Questions.prose(context.plan);
		expect(prose[0]?.anchors[0]?.epoch).toBe(rebuilt.epoch);
		expect(prose[0]?.orphaned).toBe(false);
		expect(room.matchesAnchor(rebuilt, prose[0]!.anchors[0]!, 1)).toBe(true);
	} finally {
		old.doc.destroy();
		await Service.close(context.plan);
	}
});
