import { expect, test } from "bun:test";
import * as Decisions from "./service";
import * as State from "./state";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { CommitRejected } from "../storage/errors";
import * as Edit from "../plan/edit";
import { definition, edit, fixture, member, restart } from "./service.test-fixtures";

test("concurrent create retries accept one server-generated card and commit once", async () => {
	let context = await fixture();
	let bram = member(context.plan, "bram");
	let key = crypto.randomUUID();
	let commits = 0;
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async input => {
		commits++;
		return original(input);
	};
	try {
		await Promise.all([context.ana, bram].map(actor =>
			Decisions.create(
				context.plan,
				actor.ws,
				{ kind: "visual-decision:create", ts: 0, rid: key, key },
				definition,
			)
		));
	} finally {
		context.storage.collaboration.commit = original;
	}
	let result = context.ana.frames.at(-1);
	expect(result).toMatchObject({ ok: true, state: { id: expect.any(String) } });
	expect(bram.frames.at(-1)).toEqual(result);
	expect(commits).toBe(1);
	expect(context.plan.visualDecisions.size).toBe(2);
	expect(room.questionnaireProjections(context.plan.document)).toHaveLength(2);
	expect(result?.state?.id).not.toBe(key);
});

test("a lost create reply replays the same saved card after reload without publishing", async () => {
	let context = await fixture();
	context.ana.frames.length = 0;
	await edit(context, context.ana, { selectedColor: "#123456", optionPadding: 8 });
	await Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: 1,
	});
	let expected = State.snapshot(context.plan.visualDecisions.get(context.id)!);
	let restored = await restart(context);
	let bram = member(restored, "bram");
	let source = room.project(restored.document);
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	let count = context.broadcasts.length;
	await Decisions.create(restored, bram.ws, {
		kind: "visual-decision:create",
		ts: 0,
		rid: "retry",
		key: context.createKey,
	}, { ...definition, bundleDigest: `sha256:${"b".repeat(64)}` });
	expect(bram.frames.at(-1)).toMatchObject({ ok: true, state: expected });
	expect(restored.visualDecisions.size).toBe(1);
	expect(room.project(restored.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(count);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(stored);
	expect(expected).not.toHaveProperty("createKey");
});

test("create validates bounded keys before accepting a new card", async () => {
	let context = await fixture();
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	for (let key of [undefined, null, "", "a".repeat(1000), "not-a-uuid", 3]) {
		await Decisions.create(context.plan, context.ana.ws, {
			kind: "visual-decision:create",
			ts: 0,
			rid: "invalid",
			key: key as string,
		}, definition);
		expect(context.ana.frames.at(-1)).toMatchObject({ kind: "session:error" });
	}
	expect(context.plan.visualDecisions.size).toBe(1);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(stored);
});

test("create retries still resolve at the card cap while new requests refuse", async () => {
	let context = await fixture();
	for (let index = 1; index < State.MAX_DECISIONS; index++) {
		await Decisions.create(context.plan, context.ana.ws, {
			kind: "visual-decision:create",
			ts: 0,
			rid: `create:${index}`,
			key: crypto.randomUUID(),
		}, definition);
		expect(context.ana.frames.at(-1)).toMatchObject({ ok: true });
	}
	await Decisions.create(context.plan, context.ana.ws, {
		kind: "visual-decision:create",
		ts: 0,
		rid: "over-cap",
		key: crypto.randomUUID(),
	}, definition);
	expect(context.ana.frames.at(-1)).toMatchObject({ kind: "session:error" });
	let source = room.project(context.plan.document);
	await Decisions.create(context.plan, context.ana.ws, {
		kind: "visual-decision:create",
		ts: 0,
		rid: "retry-at-cap",
		key: context.createKey,
	}, definition);
	expect(context.ana.frames.at(-1)).toMatchObject({ ok: true, state: { id: context.id } });
	expect(context.plan.visualDecisions.size).toBe(State.MAX_DECISIONS);
	expect(room.project(context.plan.document)).toBe(source);
});

test("restoration allows branch records without creation keys but rejects malformed or duplicate keys", async () => {
	let context = await fixture();
	let stored = State.dump(context.plan.visualDecisions)[0]!;
	let { createKey: _key, ...existing } = stored;
	expect(State.restore([existing]).get(context.id)).toEqual(existing);
	expect(() => State.restore([{ ...stored, createKey: "invalid" }])).toThrow();
	expect(() => State.restore([stored, { ...stored, id: "other-card" }])).toThrow();
});

test("rejected create commit keeps its key available for the same retry", async () => {
	let context = await fixture();
	let original = context.storage.collaboration.commit;
	let key = crypto.randomUUID();
	let input = { kind: "visual-decision:create" as const, ts: 0, rid: "create", key };
	context.storage.collaboration.commit = async () => {
		throw new CommitRejected();
	};
	try {
		await Decisions.create(context.plan, context.ana.ws, input, definition);
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(context.ana.frames.at(-1)).toMatchObject({ kind: "session:error" });
	expect(context.plan.visualDecisions.size).toBe(1);
	await Decisions.create(context.plan, context.ana.ws, input, definition);
	expect(context.ana.frames.at(-1)).toMatchObject({ ok: true });
	expect(context.plan.visualDecisions.size).toBe(2);
});

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

test("a Save racing an already committing edit refuses stale with the latest accepted values", async () => {
	let context = await fixture();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async input => {
		entered.resolve();
		await release.promise;
		return original(input);
	};
	let source = room.project(context.plan.document);
	let changing = edit(context, context.ana, { optionPadding: 8 });
	await entered.promise;
	let bram = member(context.plan, "bram");
	let saving = Decisions.save(context.plan, bram.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "racing",
		id: context.id,
		revision: 0,
	});
	try {
		release.resolve();
		await Promise.all([changing, saving]);
	} finally {
		context.storage.collaboration.commit = original;
		release.resolve();
	}
	expect(bram.frames.at(-1)).toMatchObject({
		ok: false,
		reason: "stale",
		state: {
			revision: 1,
			values: { optionPadding: 8 },
		},
	});
	expect(room.project(context.plan.document)).toBe(source);
	expect(context.plan.visualDecisions.get(context.id)?.saved).toBeUndefined();
	await edit(context, bram, { selectedColor: "#123456" });
	expect(bram.frames.at(-1)).toMatchObject({ ok: true, state: { revision: 2 } });
});

test("known transaction rejection remains fatal for ordinary persistence and live publication", async () => {
	let context = await fixture();
	let original = context.storage.collaboration.commit;
	let failures: unknown[] = [];
	context.plan.persistence.fatal = error => {
		failures.push(error);
	};
	let rejected = new CommitRejected();
	context.storage.collaboration.commit = async () => {
		throw rejected;
	};
	try {
		context.plan.chat.entries.push({
			id: "ordinary-message",
			ts: 1,
			text: "Changed",
			author: { kind: "member", handle: "ana" },
		});
		await expect(Service.persist(context.plan)).rejects.toBe(rejected);
		let mutation = room.insertResearch(context.plan.document, "01K0N4TR8K7JGM4R1J7PW4R8YJ");
		if (!mutation) throw new Error("Expected ordinary document mutation");
		await expect(Service.publish(context.plan, context.server, context.plan.id, mutation)).rejects
			.toBe(rejected);
		await expect(
			Service.publishStaged(context.plan, context.server, context.plan.id, { ...context.plan }),
		).rejects.toBe(rejected);
	} finally {
		context.storage.collaboration.commit = original;
		context.plan.flushing = Promise.resolve();
	}
	expect(failures).toEqual([rejected, rejected, rejected]);
});

test("Planner cannot detach, delete, replace, clear, or alter a visual projection and reload remains valid", async () => {
	let context = await fixture();
	await edit(context, context.ana, { optionPadding: 8 });
	await Decisions.save(context.plan, context.ana.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: 1,
	});
	let source = room.project(context.plan.document);
	let index = Edit.outline(context.plan).findIndex(block => block.type === "Questionnaire");
	let attempts: Edit.Operation[][] = [
		[{ op: "detach_question", id: context.id }],
		[{ op: "delete", index }],
		[{ op: "replace", index, source: "Removed.\n" }],
		[{ op: "replace_root", source: "Replacement prose.\n" }],
	];
	for (let operations of attempts) {
		expect(Edit.apply(context.plan, context.plan.revision, operations)).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(room.project(context.plan.document)).toBe(source);
	}
	for (
		let altered of [
			source.replace('visual="decision-card-v1"', ""),
			source.replace("8 px", "4 px"),
			source.replace('by="ana"', 'by="bram"'),
		]
	) {
		expect(Edit.replace(context.plan, context.plan.revision, altered)).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(room.project(context.plan.document)).toBe(source);
	}
	let restored = await restart(context);
	expect(room.project(restored.document)).toBe(source);
	expect(restored.visualDecisions.get(context.id)?.saved?.values.optionPadding).toBe(8);
});
