import { afterEach, expect, test } from "bun:test";
import { documentTitleText, parse, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import { type DocumentRoom, documentTools } from "./tools";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import * as edit from "../plan/edit";
import * as Store from "../questions/store";
import { publishQuestions } from "../questions/service-publish";
import { openPlan } from "../testing/plan";

let plans = new Set<Service.Plan>();
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans.clear();
});

async function fixture(source = "Keep this passage.\n") {
	let context = await openPlan(source);
	let { plan, server } = context;
	plans.add(plan);
	let asked = await publishQuestions(plan, server, plan.id, {
		questions: ["The note you lose", "The stability decision"].map(header => ({
			id: ulid(),
			header,
			question: `${header}?`,
			response: "text",
			multiple: false,
			options: [],
		})),
	});
	let [detached, stable] = asked;
	let entry = Store.get(plan.questions, stable!.id)!;
	let model = Question.restore([...entry.model.toBinary()], entry.definition);
	model.api.str([entry.definition.questions[0]!.id, "custom"]).ins(0, "Keep my draft");
	Store.edit(plan.questions, stable!.id, [...model.api.flush()!.toBinary()], "ana");
	await Service.persist(plan);
	let target: DocumentRoom = {
		id: plan.id,
		plan,
		server,
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		publish: mutation => Service.publish(plan, server, plan.id, mutation, { agent: true }),
		anchors() {},
		changes() {},
	};
	let apply = (operations: edit.Operation[] = [{ op: "detach_question", id: detached!.id }]) =>
		documentTools.edit_plan.execute!({
			revision: plan.revision,
			operations,
		}, { context: { room: target }, toolCallId: "detach", messages: [] } as never);
	return { ...context, detached: detached!, stable: stable!, edit: apply };
}

test("edit_plan detachment persists a cancelled record without its draft and survives reopening", async () => {
	let h = await fixture();
	let stableDraft = Store.dump(h.plan.questions).find(entry => entry.id === h.stable.id)!;
	let record = structuredClone(h.plan.records.get(h.detached.id)!);
	let revision = h.plan.revision;
	let storageRevision = h.plan.persistence.revision;
	expect(JSON.parse(await h.edit() as string)).toMatchObject({ ok: true, revision: revision + 1 });
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toMatchObject({ revision: revision + 1 });
	expect(stored.channel.revision).toBe(storageRevision + 1);
	expect(stored.sidecar).toMatchObject({
		questions: expect.arrayContaining([expect.objectContaining({
			id: h.detached.id,
			status: "cancelled",
			definition: record.definition,
			history: record.history,
		})]),
		openQuestions: [stableDraft],
	});
	await expect(h.detached.waiting).resolves.toEqual({ status: "cancelled", resolver: "chopin" });
	await Service.close(h.plan);
	plans.delete(h.plan);
	let reopened = await Service.open(h.plan.id, h.backend, h.server);
	plans.add(reopened);
	expect(reopened.records.get(h.detached.id)).toMatchObject({
		status: "cancelled",
		definition: record.definition,
		history: record.history,
	});
	expect(Store.snapshot(reopened.questions, h.detached.id)).toEqual({ open: false });
	expect(Store.dump(reopened.questions)).toEqual([stableDraft]);
	expect(room.project(reopened.document)).not.toContain(h.detached.id);
	expect(room.project(reopened.document)).toContain(h.stable.id);
});

test("failed detachment commit keeps the live record, draft, projection and waiter unchanged", async () => {
	let h = await fixture();
	let before = room.project(h.plan.document);
	let drafts = Store.dump(h.plan.questions);
	let record = structuredClone(h.plan.records.get(h.detached.id)!);
	let broadcasts = h.broadcasts.length;
	let committing = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = h.storage.collaboration.commit;
	let settled = false;
	void h.detached.waiting.then(() => settled = true);
	h.storage.collaboration.commit = async () => {
		committing.resolve();
		await release.promise;
		throw new Error("detachment commit rejected");
	};
	let pending = h.edit();
	try {
		await committing.promise;
		expect(h.plan.records.get(h.detached.id)).toEqual(record);
		expect(Store.dump(h.plan.questions)).toEqual(drafts);
		expect(room.project(h.plan.document)).toBe(before);
		expect(settled).toBe(false);
	} finally {
		release.resolve();
	}
	expect(await pending).toContain("detachment commit rejected");
	h.storage.collaboration.commit = commit;
	expect(h.plan.records.get(h.detached.id)).toEqual(record);
	expect(Store.dump(h.plan.questions)).toEqual(drafts);
	expect(Store.get(h.plan.questions, h.detached.id)?.claim).toBeUndefined();
	expect(room.project(h.plan.document)).toBe(before);
	expect(settled).toBe(false);
	expect(h.broadcasts).toHaveLength(broadcasts);
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toBeDefined();
	expect(JSON.parse(await h.edit() as string)).toMatchObject({ ok: true });
	await expect(h.detached.waiting).resolves.toEqual({ status: "cancelled", resolver: "chopin" });
});

test("detachment refuses a claimed draft without changing its document or durable state", async () => {
	let h = await fixture();
	let before = room.project(h.plan.document);
	let revision = h.plan.persistence.revision;
	let claimed = Store.claimCancel(h.plan.questions, h.detached.id, "ana");
	if (!claimed.ok) throw new Error("question was not open");
	try {
		expect(JSON.parse(await h.edit() as string)).toMatchObject({ ok: false, reason: "invalid" });
		expect(h.plan.persistence.revision).toBe(revision);
		expect(h.plan.records.get(h.detached.id)?.status).toBe("open");
		expect(room.project(h.plan.document)).toBe(before);
		expect(Store.get(h.plan.questions, h.detached.id)).toBe(claimed.claim.entry);
	} finally {
		Store.rollback(h.plan.questions, claimed.claim);
	}
});

test("a mixed title deletion and detachment keeps title identity before computing returned blocks", async () => {
	let h = await fixture("# Original title\n\n# Body heading\n\nKeep this passage.\n");
	room.enableTitle(h.plan.document);
	let result = JSON.parse(
		await h.edit([
			{ op: "delete", index: 0 },
			{ op: "detach_question", id: h.detached.id },
		]) as string,
	);
	expect(result.ok).toBe(true);
	expect(documentTitleText(parse(room.project(h.plan.document)))).toBe("");
	expect(result.blocks).toEqual(edit.outline(h.plan));
	expect(result.blocks.slice(0, 3)).toMatchObject([
		{ index: 0, type: "heading", preview: "" },
		{ index: 1, type: "heading", preview: "Body heading" },
		{ index: 2, type: "paragraph", preview: "Keep this passage." },
	]);
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toMatchObject({
		source: room.project(h.plan.document),
	});
});
