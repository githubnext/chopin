import { afterEach, expect, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as State from "./state";
import { clientEdit, fixture } from "./provenance.test-fixtures";

let contexts: Awaited<ReturnType<typeof fixture>>[] = [];
async function opened(source?: string) {
	let context = await fixture(source);
	contexts.push(context);
	return context;
}
afterEach(async () => {
	for (let context of contexts) await Service.close(context.plan);
	contexts = [];
});

test("absent legacy provenance is allowed; malformed or unbounded authority is rejected", async () => {
	let { plan } = await opened();
	expect(State.restore(undefined)).toBeUndefined();
	expect(State.restore(plan.documentDevelopment)).toEqual(plan.documentDevelopment);
	for (
		let value of [
			null,
			{},
			{ ...State.initial(), version: 2 },
			{
				...State.initial(),
				attempts: Array(9).fill(1),
			},
			{
				...State.initial(),
				passages: Array(49).fill(plan.documentDevelopment!.passages[0]),
			},
			{ ...State.initial(), unknown: true },
			{
				...State.initial(),
				pending: { input: {} },
			},
		]
	) expect(() => State.restore(value)).toThrow();
});

test("a persisted human edit permanently protects a passage even after undo", async () => {
	let { plan } = await opened();
	let generated = plan.documentDevelopment!.passages[0]!.generatedDigest;
	await clientEdit(plan, { index: 1, text: "The person has a different view." });
	expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	expect(plan.documentDevelopment!.passages[0]!.generatedDigest).toBe(generated);
	await clientEdit(plan, { index: 1, text: "A draft observation." });
	expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	expect(room.digests(plan.document)[1]).toBe(generated);
});

test("insertion above a passage retains ownership and resolves its new index", async () => {
	let { plan } = await opened();
	await clientEdit(plan, [{ op: "insert", index: 0, source: "New human paragraph." }]);
	let passage = plan.documentDevelopment!.passages[0]!;
	expect(passage.status).toBe("generated");
	expect(State.indexOf(plan.document, passage)).toBe(2);
});

test("deletions and human moves lose ownership without adopting identical text", async () => {
	for (
		let operations of [
			[{ op: "delete", index: 1 }],
			[{ op: "move", index: 1, to: 2 }],
			[{ op: "replace", index: 1, source: "A draft observation.\n\nA draft observation." }],
		] as const
	) {
		let { plan } = await opened();
		await clientEdit(plan, [...operations]);
		expect(plan.documentDevelopment!.passages[0]!.status).toBe("orphaned");
	}
});

test("a known checkpoint epoch rebuild retains untouched Yjs identity", async () => {
	let { plan } = await opened();
	let prior = plan.document;
	plan.document = await room.rebuild(prior);
	let captured = State.capture(plan)!;
	expect(captured.passages[0]!.status).toBe("generated");
	expect(captured.passages[0]!.anchor.epoch).toBe(plan.document.epoch);
	expect(plan.documentDevelopment!.passages[0]!.anchor.epoch).toBe(prior.epoch);
	prior.doc.destroy();
});

test("answer-linked prose becomes protected in a sidecar-only commit", async () => {
	let { plan } = await opened();
	let passage = plan.documentDevelopment!.passages[0]!;
	plan.records.set(
		"decision",
		Questions.normalizeRecord({
			id: "decision",
			status: "answered",
			definition: {
				questions: [{
					id: "question",
					question: "Which path?",
					header: "Path",
					multiple: false,
					options: [{ id: "option", label: "This path", description: "" }],
				}],
			},
			prose: [passage.anchor],
		}),
	);
	expect(State.capture(plan)!.passages[0]!.status).toBe("protected");
	expect(passage.status).toBe("generated");
	await Service.persist(plan);
	expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
});

test("accepted comments and resolved Planner results protect their linked prose", async () => {
	for (let status of ["accepted", "resolved"] as const) {
		let { plan } = await opened();
		let passage = plan.documentDevelopment!.passages[0]!;
		plan.threads.set("comment", {
			id: "comment",
			status,
			passage: room.passageAt(plan.document, [1], "A draft", 0, 7),
			notes: [],
			...(status === "resolved" ? { result: { anchors: [passage.anchor], pending: false } } : {}),
		});
		await Service.persist(plan);
		expect(plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	}
});

test("protection survives closing and restoring the durable document", async () => {
	let context = await opened();
	await clientEdit(context.plan, { index: 1, text: "A human revision." });
	await Service.close(context.plan);
	context.plan = await Service.open(context.plan.id, context.backend, context.server);
	expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
	await clientEdit(context.plan, { index: 1, text: "A draft observation." });
	expect(context.plan.documentDevelopment!.passages[0]!.status).toBe("protected");
});
