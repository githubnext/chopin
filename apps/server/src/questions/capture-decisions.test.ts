import { afterEach, expect, spyOn, test } from "bun:test";
import { ULID } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Edit from "../plan/edit";
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
	Edit.outline(plan);
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

test("mixed replay and new capture after the document moved on rebases and reuses a paragraph scope", async () => {
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
	expect(first.revision).toBeGreaterThan(input.revision);
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	expect(result.decisions[0]!.id).toBe(first.decisions[0]!.id);
	expect(context.plan.records.size).toBe(2);
	let scopes = result.decisions.map(item => context.plan.records.get(item.id)!.followUp!.scope);
	expect(scopes[0]).toBe(scopes[1]);
});

async function rewrite(context: Awaited<ReturnType<typeof setup>>, source: string) {
	let outcome = Edit.apply(context.plan, context.plan.revision, [{ op: "replace_root", source }]);
	if (!outcome.ok) throw new Error("fixture edit failed");
	if (outcome.mutation) {
		await Plan.publish(context.plan, context.server, context.plan.id, outcome.mutation);
	}
}

async function edited(
	context: Awaited<ReturnType<typeof setup>>,
	operations: Edit.Operation[],
) {
	let outcome = Edit.apply(context.plan, context.plan.revision, operations);
	if (!outcome.ok) throw new Error("fixture edit failed");
	if (outcome.mutation) {
		await Plan.publish(context.plan, context.server, context.plan.id, outcome.mutation);
	}
}

test("a capture read before an unrelated edit still lands beside its paragraph, once, however often it is retried", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await edited(context, [{ op: "insert_root", source: "A late note." }]);
	expect(context.plan.revision).toBeGreaterThan(input.revision);
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	let id = first.decisions[0]!.id;
	expect(first.revision).toBe(context.plan.revision);
	expect(
		Room.matchesAnchor(
			context.plan.document,
			context.plan.records.get(id)!.followUp!.target[0]!,
			1,
		),
	)
		.toBe(true);
	expect(Room.questionnaireIndex(context.plan.document, id)).toBe(2);
	let again = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	expect(again.decisions).toEqual(first.decisions);
	expect(context.plan.records.size).toBe(1);
	expect(context.plan.questions.open.size).toBe(1);
});

test("a capture read before a paragraph moved follows the paragraph by its digest", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await edited(context, [{ op: "insert", index: 0, source: "A new introduction." }]);
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	let id = result.decisions[0]!.id;
	expect(
		Room.matchesAnchor(
			context.plan.document,
			context.plan.records.get(id)!.followUp!.target[0]!,
			2,
		),
	)
		.toBe(true);
	expect(Room.questionnaireIndex(context.plan.document, id)).toBe(3);
});

test("a capture whose paragraph changed since it was read is refused and creates nothing", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await rewrite(
		context,
		"# Draft\n\nProvisional onboarding, rewritten.\n\nProvisional collaboration.",
	);
	let frames = context.broadcasts.length;
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, input))
		.rejects.toThrow("The document changed; read it again before opening a decision");
	expect(context.plan.records.size).toBe(0);
	expect(context.plan.questions.open.size).toBe(0);
	expect(context.broadcasts).toHaveLength(frames);
	let fresh = {
		...input,
		revision: context.plan.revision,
		questions: [question(context.plan, "decision-one")],
	};
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, fresh);
	expect(result.decisions).toHaveLength(1);
	expect(context.plan.records.size).toBe(1);
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

const SAME_KEY = "already holds a different decision";

test.each([
	["question", true, { question: "What should collaboration teach?" }],
	["description", true, { description: "Think about the first hour." }],
	["response kind", true, {
		response: undefined,
		options: [{ label: "First task", description: "Begin with a useful action" }],
	}],
	["choices", false, { options: [{ label: "Tour", description: "Walk through" }] }],
])(
	"a repeated key with a different %s is refused and the first card is untouched",
	async (_, written, change) => {
		let context = await setup();
		let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
			revision: 0,
			questions: [question(context.plan, "decision-one", 1, written)],
		});
		let id = first.decisions[0]!.id;
		let before = structuredClone(context.plan.records.get(id)!.definition);
		let source = Room.project(context.plan.document);
		let frames = context.broadcasts.length;
		let { response: _response, ...base } = question(context.plan, "decision-one", 1, written);
		let changed = { ...base, ...(written ? { response: "text" as const } : {}), ...change };
		if ("response" in change) delete (changed as { response?: unknown }).response;
		await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
			revision: context.plan.revision,
			questions: [changed],
		})).rejects.toThrow(SAME_KEY);
		expect(context.plan.records.size).toBe(1);
		expect(context.plan.records.get(id)!.definition).toEqual(before);
		expect(context.plan.questions.open.size).toBe(1);
		expect(Room.project(context.plan.document)).toBe(source);
		expect(context.broadcasts).toHaveLength(frames);
	},
);

test("a repeated key naming another paragraph is refused instead of keeping the card beside the first", async () => {
	let context = await setup();
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one", 1)],
	});
	let moved = question(context.plan, "decision-one", 2);
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [moved],
	})).rejects.toThrow(SAME_KEY);
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [question(context.plan, "decision-one", 3)],
	})).rejects.toThrow(SAME_KEY);
	expect(context.plan.records.size).toBe(1);
	expect(first.decisions).toHaveLength(1);
	expect(
		Room.matchesAnchor(
			context.plan.document,
			context.plan.records.get(first.decisions[0]!.id)!.followUp!.target[0]!,
			1,
		),
	)
		.toBe(true);
});

test("one mismatched key refuses the whole batch, so no replay is repeated and no new card is made", async () => {
	let context = await setup();
	let one = question(context.plan, "decision-one", 1);
	let two = question(context.plan, "decision-two", 2);
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [one, two],
	});
	let source = Room.project(context.plan.document);
	let frames = context.broadcasts.length;
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [
			one,
			{ ...two, question: "What else should collaboration teach?" },
			question(context.plan, "decision-three", 1),
		],
	})).rejects.toThrow(SAME_KEY);
	expect(context.plan.records.size).toBe(2);
	expect(context.plan.questions.open.size).toBe(2);
	expect(Room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(frames);
});

test("an identical replay stays idempotent after a person added an option to the open card", async () => {
	let context = await setup();
	let choices = question(context.plan, "decision-one", 1, false);
	let first = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [choices],
	});
	let id = first.decisions[0]!.id;
	let actor = member();
	await Questions.addOption(context.plan, context.server, context.plan.id, actor.ws, {
		kind: "question:option",
		ts: 0,
		rid: "add",
		id,
		question: context.plan.records.get(id)!.definition.questions[0]!.id,
		key: "added-option",
		label: "Shadow a teammate",
	});
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toHaveLength(3);
	let again = await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [choices],
	});
	expect(again.decisions).toEqual(first.decisions);
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toHaveLength(3);
	expect(context.plan.records.size).toBe(1);
});

test("a capture read before an identical paragraph appeared is refused as ambiguous and creates nothing", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await edited(context, [{ op: "insert", index: 0, source: "Provisional onboarding." }]);
	let source = Room.project(context.plan.document);
	let frames = context.broadcasts.length;
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, input))
		.rejects.toThrow("The document changed; read it again before opening a decision");
	expect(context.plan.records.size).toBe(0);
	expect(context.plan.questions.open.size).toBe(0);
	expect(Room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(frames);
	// Read again, the Planner names the very block it means and the card goes there.
	let fresh = {
		revision: context.plan.revision,
		questions: [question(context.plan, "decision-one", 2)],
	};
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, fresh);
	let id = result.decisions[0]!.id;
	expect(
		Room.matchesAnchor(
			context.plan.document,
			context.plan.records.get(id)!.followUp!.target[0]!,
			2,
		),
	)
		.toBe(true);
});

const REFUSED = "The document changed; read it again before opening a decision";

async function expectNothingCreated(
	context: Awaited<ReturnType<typeof setup>>,
	input: Parameters<typeof Capture.captureDecisions>[3],
	cards = 0,
	cause?: string,
) {
	let source = Room.project(context.plan.document);
	let frames = context.broadcasts.length;
	let refusal = await Capture.captureDecisions(context.plan, context.server, context.plan.id, input)
		.then(() => undefined, (error: unknown) => error as Error);
	expect(refusal?.message).toContain(REFUSED);
	if (cause) expect(refusal?.message).toContain(cause);
	expect(refusal?.message).not.toContain("different decision");
	expect(refusal?.message).not.toContain("new key");
	expect(context.plan.records.size).toBe(cards);
	expect(context.plan.questions.open.size).toBe(cards);
	expect(Room.project(context.plan.document)).toBe(source);
	expect(context.broadcasts).toHaveLength(frames);
}

test("a capture whose paragraph was rewritten beside an identical copy is refused, not moved onto the copy", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await edited(context, [{
		op: "replace",
		index: 1,
		source: "Provisional onboarding, rewritten.",
	}]);
	await edited(context, [{ op: "insert_root", source: "Provisional onboarding." }]);
	await expectNothingCreated(context, input, 0, "has been rewritten, removed or moved since");
	let fresh = {
		revision: context.plan.revision,
		questions: [question(context.plan, "decision-one", 3)],
	};
	let result = await Capture.captureDecisions(context.plan, context.server, context.plan.id, fresh);
	expect(context.plan.records.get(result.decisions[0]!.id)).toBeDefined();
});

test("a capture whose paragraph was already repeated when it was read is refused once one copy is rewritten", async () => {
	let context = await setup(
		"# Draft\n\nProvisional onboarding.\n\nProvisional onboarding.\n\nProvisional collaboration.",
	);
	let input = { revision: 0, questions: [question(context.plan, "decision-one", 1)] };
	await edited(context, [{
		op: "replace",
		index: 1,
		source: "Provisional onboarding, rewritten.",
	}]);
	await expectNothingCreated(context, input, 0, "appeared more than once when you read it");
});

test("a capture read at a revision that is no longer retained is refused instead of guessed", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await rewrite(
		context,
		"# Draft\n\nProvisional onboarding.\n\nProvisional collaboration.\n\nA late note.",
	);
	context.plan.outlines.clear();
	await expectNothingCreated(context, input, 0, "the server no longer has that read");
});

test("a repeated key whose paragraph was rewritten since is refused as a changed document, not as a different decision", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	await edited(context, [{
		op: "replace",
		index: 1,
		source: "Provisional onboarding, rewritten.",
	}]);
	await expectNothingCreated(context, input, 1);
});

test("a repeated key whose paragraph was rewritten beside an identical copy is refused, not replayed onto the copy", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	await edited(context, [{
		op: "replace",
		index: 1,
		source: "Provisional onboarding, rewritten.",
	}]);
	await edited(context, [{ op: "insert_root", source: "Provisional onboarding." }]);
	await expectNothingCreated(context, input, 1);
});

test("a repeated key naming another intact paragraph is still a different decision when the document has moved on", async () => {
	let context = await setup();
	let first = question(context.plan, "decision-one", 1);
	let other = question(context.plan, "decision-one", 2);
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [first],
	});
	await edited(context, [{ op: "insert_root", source: "A late note." }]);
	await expect(Capture.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [other],
	})).rejects.toThrow(SAME_KEY);
	expect(context.plan.records.size).toBe(1);
});

test("a repeated key whose read was evicted is refused when its card no longer stands beside the paragraph", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one")] };
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	await edited(context, [{
		op: "replace",
		index: 1,
		source: "Provisional onboarding, rewritten.",
	}]);
	await edited(context, [{ op: "insert_root", source: "Provisional onboarding." }]);
	for (let note = 0; note < 9; note++) {
		await edited(context, [{ op: "insert_root", source: `Note ${note}.` }]);
		Edit.outline(context.plan);
	}
	expect(Edit.read(context.plan, 0)).toBeUndefined();
	await expectNothingCreated(context, input, 1, "the server no longer has that read");
});

test("a stale address whose index disagrees with its digest is refused as the fresh one is", async () => {
	let context = await setup();
	let input = { revision: 0, questions: [question(context.plan, "decision-one", 1)] };
	input.questions[0]!.blocks[0]!.digest = Room.digests(context.plan.document)[2]!;
	await edited(context, [{ op: "insert_root", source: "A late note." }]);
	await expectNothingCreated(context, input, 0, "does not match the block you read");
});

test("a repeated key whose read was evicted is refused when a later passage was rewritten beside an identical copy", async () => {
	let context = await setup(
		"# Draft\n\nProvisional onboarding.\n\nProvisional collaboration.\n\nProvisional pricing.",
	);
	let single = question(context.plan, "decision-one", 1);
	let digests = Room.digests(context.plan.document);
	let input = {
		revision: 0,
		questions: [{ ...single, blocks: [1, 2].map(index => ({ index, digest: digests[index]! })) }],
	};
	await Capture.captureDecisions(context.plan, context.server, context.plan.id, input);
	await edited(context, [{
		op: "replace",
		index: 3,
		source: "Provisional collaboration, rewritten.",
	}]);
	await edited(context, [{ op: "insert_root", source: "Provisional collaboration." }]);
	for (let note = 0; note < 9; note++) {
		await edited(context, [{ op: "insert_root", source: `Note ${note}.` }]);
		Edit.outline(context.plan);
	}
	expect(Edit.read(context.plan, 0)).toBeUndefined();
	await expectNothingCreated(context, input, 1, "the server no longer has that read");
});
