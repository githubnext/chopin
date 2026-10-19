import { afterEach, expect, spyOn, test } from "bun:test";
import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Room from "../plan/room";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import * as Capture from "./service-capture";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];
afterEach(async () => {
	for (let context of contexts) await Plan.close(context.plan);
	contexts = [];
});

async function setup(source = "# Draft\n\nProvisional onboarding.\n\nProvisional collaboration.") {
	let context = await openPlan(source);
	contexts.push(context);
	return context;
}

function question(plan: Plan.Plan, key: string, index = 1, written = true) {
	return {
		key,
		header: "Onboarding",
		question: "What should onboarding teach?",
		...(written ? { response: "text" as const } : {}),
		multiple: false,
		options: written ? [] : [
			{ label: "First task", description: "Begin with a useful action" },
			{ label: "Team context", description: "Begin with collaborators" },
		],
		blocks: [{ index, digest: Room.digests(plan.document)[index]! }],
	};
}

test("six mixed captures return open cards beside their prose in one durable batch", async () => {
	let context = await setup();
	let questions = Array.from(
		{ length: 6 },
		(_, i) => question(context.plan, `decision-${i}`, i < 3 ? 1 : 2, i % 2 === 0),
	);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = context.storage.collaboration.commit.bind(context.storage.collaboration);
	let held = spyOn(context.storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	});
	try {
		let pending = Capture.captureDecisions(context.plan, context.server, context.plan.id, {
			revision: 0,
			questions,
		});
		await entered.promise;
		expect(context.plan.records.size).toBe(0);
		expect(context.plan.questions.open.size).toBe(0);
		expect(context.broadcasts).toEqual([]);
		release.resolve();
		let result = await pending;
		expect(result.revision).toBe(1);
		expect(result.decisions.map(item => item.status)).toEqual(Array(6).fill("open"));
		expect(context.plan.questions.open.size).toBe(6);
		expect(held).toHaveBeenCalledTimes(1);
		let records = result.decisions.map(item => context.plan.records.get(item.id)!);
		let scopes = records.map(record => record.followUp!.scope);
		expect(scopes.every(scope => ULID.test(scope))).toBe(true);
		expect(new Set(scopes.slice(0, 3)).size).toBe(1);
		expect(new Set(scopes.slice(3)).size).toBe(1);
		expect(scopes[0]).not.toBe(scopes[3]);
		for (let [index, record] of records.entries()) {
			expect(record.followUp!.target).toHaveLength(1);
			expect(
				Room.matchesAnchor(context.plan.document, record.followUp!.target[0]!, index < 3 ? 1 : 5),
			)
				.toBe(true);
			expect(Room.questionnaireIndex(context.plan.document, record.id)).toBe(
				index < 3 ? index + 2 : index + 3,
			);
		}
		await Plan.close(context.plan);
		context.plan = await Plan.open(context.plan.id, context.backend, context.server);
		expect([...context.plan.records.values()].map(record => record.followUp!.scope)).toEqual(
			scopes,
		);
	} finally {
		release.resolve();
		held.mockRestore();
	}
});

test("capture replay survives Save and restart without rebinding the saved card", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	let id = first.decisions[0]!.id;
	let entry = Store.get(context.plan.questions, id)!;
	let fork = entry.model.fork() as Question.Model;
	fork.api.str([entry.definition.questions[0]!.id, "custom"]).ins(0, "Teach the first task.");
	let actor = member();
	await Questions.edit(context.plan, actor.ws, {
		kind: "question:edit",
		ts: 0,
		rid: "draft",
		id,
		patch: [...fork.api.flush().toBinary()],
	});
	await Questions.submit(context.plan, context.server, context.plan.id, actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(context.plan.questions, id)!.revision,
	});
	let captured = structuredClone(context.plan.records.get(id)!.followUp);
	await Plan.close(context.plan);
	context.plan = await Plan.open(context.plan.id, context.backend, context.server);
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	expect(result.decisions).toEqual([{ key: "decision-one", id, status: "answered" }]);
	expect(context.plan.records.size).toBe(1);
	expect(context.plan.records.get(id)!.followUp).toEqual(captured);
});

test("mixed replay and new capture requires the current revision and reuses a paragraph scope", async () => {
	let context = await setup();
	let firstQuestion = question(context.plan, "decision-one");
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [firstQuestion],
	});
	let input = {
		revision: 0,
		questions: [firstQuestion, question(context.plan, "decision-two")],
	};
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, input))
		.rejects.toThrow(/changed/);
	expect(context.plan.records.size).toBe(1);
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		...input,
		revision: first.revision,
	});
	expect(result.decisions[0]!.id).toBe(first.decisions[0]!.id);
	expect(context.plan.records.size).toBe(2);
	let scopes = result.decisions.map(item => context.plan.records.get(item.id)!.followUp!.scope);
	expect(scopes[0]).toBe(scopes[1]);
});

test.each(["empty", "heading", "stale-block", "duplicate-key", "too-many", "nontext-key"])(
	"invalid %s capture changes neither records nor source",
	async kind => {
		let context = await setup();
		let before = Room.project(context.plan.document);
		let item = question(context.plan, "decision-one");
		if (kind === "nontext-key") item.key = undefined as never;
		if (kind === "empty") item.blocks = [];
		if (kind === "heading") {
			item.blocks = [{ index: 0, digest: Room.digests(context.plan.document)[0]! }];
		}
		if (kind === "stale-block") item.blocks[0]!.digest = `sha256:${"0".repeat(64)}`;
		let questions = kind === "duplicate-key" ? [item, item] : kind === "too-many"
			? Array.from({ length: 11 }, (_, index) => ({ ...item, key: `decision-${index}` }))
			: [item];
		await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
			revision: 0,
			questions,
		})).rejects.toThrow();
		expect(context.plan.records.size).toBe(0);
		expect(Room.project(context.plan.document)).toBe(before);
		expect(context.broadcasts).toEqual([]);
	},
);

test("failed batch commit leaves no cards, drafts or publication and retries the complete batch", async () => {
	let context = await setup();
	let input = {
		revision: 0,
		questions: [question(context.plan, "decision-one"), question(context.plan, "decision-two")],
	};
	let before = Room.project(context.plan.document);
	let held = spyOn(context.storage.collaboration, "commit").mockRejectedValueOnce(
		new Error("storage unavailable"),
	);
	try {
		await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, input))
			.rejects.toThrow("storage unavailable");
		expect(context.plan.records.size).toBe(0);
		expect(context.plan.questions.open.size).toBe(0);
		expect(Room.project(context.plan.document)).toBe(before);
		expect(context.broadcasts).toEqual([]);
		expect(
			(await Capture.captureDecisions(context.plan, context.server, context.plan.id, input))
				.decisions,
		)
			.toHaveLength(2);
	} finally {
		held.mockRestore();
	}
});

test("a capture cancelled while waiting for the document queue never publishes", async () => {
	let context = await setup();
	let controller = new AbortController();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let queue = Plan.exclusive(context.plan, async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	try {
		let pending = Capture.captureDecisions(context.plan, context.server, context.plan.id, {
			revision: 0,
			questions: [question(context.plan, "decision-one")],
		}, controller.signal);
		controller.abort();
		release.resolve();
		await queue;
		await expect(pending).rejects.toThrow(/cancelled|aborted/i);
		expect(context.plan.records.size).toBe(0);
		expect(context.broadcasts).toEqual([]);
	} finally {
		release.resolve();
		await queue;
	}
});

test("legacy unanchored capture has no saved-answer continuation", async () => {
	let context = await setup();
	let id = await Capture.capture(context.plan, context.server, context.plan.id, {
		key: "decision-one",
		question: "How should onboarding work?",
	}, { revision: 0 });
	expect(context.plan.records.get(id)!.followUp).toBeUndefined();
});

test("a split scope target refuses new capture instead of merging unrelated prose", async () => {
	let context = await setup();
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one")],
	});
	let record = context.plan.records.get(first.decisions[0]!.id)!;
	let secondary = Room.anchorAt(context.plan.document, 3, Room.digests(context.plan.document)[3]!);
	record.followUp!.target.push(secondary);
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: first.revision,
		questions: [question(context.plan, "decision-two")],
	})).rejects.toThrow("no longer contiguous");
	expect(context.plan.records.size).toBe(1);
});

test("an orphaned primary target cannot reuse a scope through its secondary target", async () => {
	let context = await setup();
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one")],
	});
	let original = context.plan.records.get(first.decisions[0]!.id)!.followUp!;
	original.target = [{ ...original.target[0]!, orphaned: true }, original.target[0]!];
	let next = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: first.revision,
		questions: [question(context.plan, "decision-two")],
	});
	expect(context.plan.records.get(next.decisions[0]!.id)!.followUp!.scope).not.toBe(original.scope);
});

test("blocking ask retains its own wait and cancellation lifecycle without follow-up metadata", async () => {
	let context = await setup();
	let item = question(context.plan, "decision-one");
	let { key: _key, blocks, ...value } = item;
	let controller = new AbortController();
	let created = Promise.withResolvers<void>();
	let pending = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({ questions: [value] }),
		{ revision: 0, blocks: [blocks] },
		() => created.resolve(),
		controller.signal,
	);
	await created.promise;
	expect([...context.plan.records.values()][0]!.followUp).toBeUndefined();
	expect(context.plan.questions.open.size).toBe(1);
	controller.abort();
	expect((await pending)[0]!.status).toBe("cancelled");
});
