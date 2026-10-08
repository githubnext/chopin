import { expect, test } from "bun:test";
import * as Decisions from "./service";
import * as State from "./state";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { CommitRejected } from "../storage/errors";
import { definition, edit, fixture, member, restart } from "./service.test-fixtures";

test("accepted per-control edits converge, replay cannot overwrite a newer peer, and reload restores", async () => {
	let context = await fixture();
	let bram = member(context.plan, "bram");
	let key = context.ana.key();
	await edit(context, context.ana, { optionPadding: 8 }, key);
	await edit(context, bram, { selectedColor: "#123456" });
	await edit(context, bram, { optionPadding: 4 });
	await edit(context, context.ana, { optionPadding: 8 }, key);
	expect(context.plan.visualDecisions.get(context.id)).toMatchObject({
		revision: 3,
		values: { optionPadding: 4, selectedColor: "#123456" },
	});
	let restored = await restart(context);
	expect(State.snapshot(restored.visualDecisions.get(context.id)!)).toMatchObject({
		revision: 3,
		definition,
		values: { optionPadding: 4, selectedColor: "#123456" },
	});
});

test("stale Save refuses exact latest state without changing document or publishing", async () => {
	let context = await fixture();
	await edit(context, context.ana, { optionPadding: 8 });
	let source = room.project(context.plan.document);
	let count = context.broadcasts.length;
	await Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "stale",
		id: context.id,
		revision: 0,
	});
	expect(context.ana.frames.at(-1)).toMatchObject({
		ok: false,
		reason: "stale",
		state: { revision: 1, values: { optionPadding: 8 } },
	});
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(count);
	expect(context.plan.visualDecisions.get(context.id)?.saved).toBeUndefined();
});

test("claimed Save pauses edits, durably projects exact values and saver, and survives reload", async () => {
	let context = await fixture();
	await edit(context, context.ana, { selectedColor: "#123456", optionPadding: 8 });
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let waiting = Service.exclusive(context.plan, async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	let saving = Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: 1,
	});
	let bram = member(context.plan, "bram");
	let changing = edit(context, bram, { optionPadding: 4 });
	release.resolve();
	await Promise.all([waiting, saving, changing]);
	expect(bram.frames.at(-1)).toMatchObject({ ok: false, reason: "saving" });
	let saved = context.plan.visualDecisions.get(context.id)?.saved;
	expect(saved).toMatchObject({
		revision: 1,
		values: { optionPadding: 8, selectedColor: "#123456" },
		by: "ana",
	});
	expect(room.project(context.plan.document)).toContain('by="ana"');
	expect(room.project(context.plan.document)).toContain(
		"Option vertical padding: 8 px; selected-option colour: #123456",
	);
	let restored = await restart(context);
	expect(restored.visualDecisions.get(context.id)?.saved).toEqual(saved);
});

test("known aborted commit publishes nothing, releases Save, and allows successful retry", async () => {
	let context = await fixture();
	await edit(context, context.ana, { optionPadding: 8 });
	let source = room.project(context.plan.document);
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	let count = context.broadcasts.length;
	let original = context.storage.collaboration.commit;
	let fatal = false;
	context.plan.persistence.fatal = () => {
		fatal = true;
	};
	context.storage.collaboration.commit = async () => {
		throw new CommitRejected();
	};
	try {
		await Decisions.save(context.plan, context.ana.ws, {
			kind: "visual-decision:save",
			ts: 0,
			rid: "failed",
			id: context.id,
			revision: 1,
		});
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(fatal).toBe(false);
	expect(context.ana.frames.at(-1)).toMatchObject({ kind: "session:error" });
	expect(context.plan.visualDecisions.get(context.id)?.saved).toBeUndefined();
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(count);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(stored);
	await edit(context, context.ana, { selectedColor: "#ABCDEF" });
	await Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "retry",
		id: context.id,
		revision: 2,
	});
	expect(context.ana.frames.at(-1)).toMatchObject({
		ok: true,
		state: { saved: { values: { selectedColor: "#ABCDEF" } } },
	});
});

test("viewers read accepted drafts but cannot change or save and invalid patches never persist", async () => {
	let context = await fixture();
	let viewer = member(context.plan, "viewer", false);
	await Decisions.open(context.plan, viewer.ws, {
		kind: "visual-decision:open",
		ts: 0,
		rid: "view",
		id: context.id,
	});
	expect(viewer.frames.at(-1)).toMatchObject({ ok: true, state: { revision: 0 } });
	await edit(context, viewer, { optionPadding: 8 });
	expect(viewer.frames.at(-1)).toMatchObject({ kind: "session:error" });
	await Decisions.save(context.plan, viewer.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: 0,
	});
	expect(viewer.frames.at(-1)).toMatchObject({ kind: "session:error" });
	await edit(context, context.ana, { selectedColor: "url(secret)" });
	expect(context.ana.frames.at(-1)).toMatchObject({ kind: "session:error" });
	expect(context.plan.visualDecisions.get(context.id)?.revision).toBe(0);
});

test("Save claims before the lifecycle gate and a rejected gate releases the draft", async () => {
	let context = await fixture();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let saving = Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "lifecycle",
		id: context.id,
		revision: 0,
	}, async () => {
		entered.resolve();
		await release.promise;
		throw new Error("Document is unavailable");
	});
	await entered.promise;
	let bram = member(context.plan, "bram");
	await Decisions.save(context.plan, bram.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "rival",
		id: context.id,
		revision: 0,
	});
	expect(bram.frames.at(-1)).toMatchObject({ ok: false, reason: "saving" });
	await edit(context, bram, { optionPadding: 8 });
	expect(bram.frames.at(-1)).toMatchObject({ ok: false, reason: "saving" });
	release.resolve();
	await saving;
	await edit(context, bram, { optionPadding: 8 });
	expect(bram.frames.at(-1)).toMatchObject({ ok: true, state: { revision: 1 } });
});

test("unknown commit failure still invokes the fatal storage boundary", async () => {
	let context = await fixture();
	let original = context.storage.collaboration.commit;
	let fatal: unknown;
	context.plan.persistence.fatal = error => {
		fatal = error;
	};
	let error = new Error("Unknown connection loss during commit");
	context.storage.collaboration.commit = async () => {
		throw error;
	};
	try {
		await Decisions.save(context.plan, context.ana.ws, {
			kind: "visual-decision:save",
			ts: 0,
			rid: "ambiguous",
			id: context.id,
			revision: 0,
		});
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(fatal).toBe(error);
	expect(context.plan.visualDecisions.get(context.id)?.saved).toBeUndefined();
});
