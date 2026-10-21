import { afterEach, expect, test } from "bun:test";
import * as Question from "@chopin/question";

import { serverInstruction } from "../chat/server-instruction";
import * as Chat from "../chat/service";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Rooms from "../rooms";
import { openPlan } from "../testing/plan";

import { answerInstruction, answerTurns } from "./answer-turns";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

import type { Instruction, ServerInstructionDeps } from "../chat/server-instruction";
import type { Config } from "../config";
import type { Plan } from "../plan/service";
import type { DecisionAnswerStore } from "../storage/port";

let plans: Plan[] = [];
let cleanups: Array<() => void> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) cleanup();
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

/** Long enough that only `pending` sends answers, as an owner appearing or a Planner attaching does. */
const WINDOW = { quietMs: 60_000, longestMs: 60_000 };
const REPOSITORY = { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" };

const SOURCE = "# Login plan\n\n## Strip rule\n\nA short password has a strip no other shares.\n";

async function opened() {
	let told: Array<[string, number]> = [];
	// `restart` replaces `plan`, so every helper reads it from here.
	let context = { ...await openPlan(SOURCE), told };
	plans.push(context.plan);
	/** Select an option, or write an answer, then Save it as `handle`. */
	async function save(id: string, answer: { option: number } | { text: string }, handle = "ana") {
		let actor = member(handle);
		let entry = Store.get(context.plan.questions, id)!;
		let question = entry.definition.questions[0]!;
		let fork = entry.model.fork() as Question.Model;
		if ("option" in answer) {
			fork.api.val([question.id, "choice"]).set(question.options[answer.option]!.id);
		} else fork.api.str([question.id, "custom"]).ins(0, answer.text);
		await Questions.edit(context.plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(
			context.plan,
			context.server,
			context.plan.id,
			actor.ws,
			{
				kind: "question:submit",
				ts: 0,
				rid: "save",
				id,
				revision: Store.get(context.plan.questions, id)!.revision,
			},
			undefined,
			(answered, generation) => told.push([answered, generation]),
		);
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	}
	return Object.assign(context, { save });
}

/** A choice the Planner left beside the strip paragraph without waiting for it. */
async function captured(
	context: Awaited<ReturnType<typeof opened>>,
	question = "How should the wrong sentence be fixed?",
) {
	let digests = Room.digests(context.plan.document);
	let result = await Questions.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [{
			key: `fix-${question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`,
			header: "Fix",
			question,
			options: [
				{ label: "Start a new run (recommended)", description: "A run makes the fix." },
				{ label: "Edit the sentence only", description: "Faster." },
			],
			multiple: false,
			blocks: [{ index: 2, digest: digests[2]! }],
		}],
	});
	return result.decisions[0]!.id;
}

test("saving a decision the Planner left open hands its answer to the Planner once", async () => {
	let context = await opened();
	let choice = await captured(context);
	let written = await Questions.capture(context.plan, context.server, context.plan.id, {
		key: "run-replacement",
		question: "Should the replacement run keep going?",
	}, { revision: context.plan.revision });

	await context.save(choice, { option: 0 });
	await context.save(written, { text: "Keep it running." });

	expect(context.told).toEqual([[choice, 1], [written, 1]]);
});

test("an answer a turn or a workflow is waiting for reaches it directly and starts no turn", async () => {
	let context = await opened();
	let created = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let blocking = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({
			questions: [{
				header: "Scope",
				question: "Which scope?",
				multiple: false,
				options: [{ label: "Small", description: "" }, { label: "Large", description: "" }],
			}],
		}),
		undefined,
		created[0]!.resolve,
	);
	let workflow = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({
			questions: [{
				header: "Door",
				question: "Which door?",
				multiple: false,
				options: [{ label: "A", description: "" }, { label: "B", description: "" }],
			}],
		}, { verbatim: true }),
		undefined,
		created[1]!.resolve,
	);
	let human = await Questions.capture(context.plan, context.server, context.plan.id, {
		key: "human-question",
		question: "What do we call it?",
	}, { human: "ana" });
	await Promise.all(created.map(item => item.promise));
	let [asked, hosted] = [...context.plan.records.values()]
		.filter(record => record.id !== human)
		.map(record => record.id);

	await context.save(asked!, { option: 0 });
	await context.save(hosted!, { option: 1 });
	await context.save(human, { text: "Strip rule" });

	expect((await blocking)[0]).toMatchObject({ status: "answered", resolver: "ana" });
	expect((await workflow)[0]).toMatchObject({ status: "answered", resolver: "ana" });
	expect(context.told).toEqual([]);
});

/**
 * The Planner as `main.ts` reaches it: `serverInstruction` over the document's real Chat, under an
 * existing owner while `planner.owner` is set. A member's turn is running, so each accepted answer
 * turn queues behind it with its notice saved, as Chat keeps it across a restart.
 */
function planner(context: { plan: Plan }) {
	let planner = { owner: true, started: 0 };
	let deps: ServerInstructionDeps = {
		agent: true,
		unavailable: () => false,
		owner: async () => planner.owner ? { repository: REPOSITORY, release: () => {} } : undefined,
		transition: (_id, action) => action(),
		open: async room => (room.plan = context.plan),
		conversation: room => {
			context.plan.chat.busy = true;
			return {
				chat: context.plan.chat,
				plan: context.plan,
				room: room.id,
				server: { publish() {} },
				config: { agent: true } as Config,
				claimantSessionId: undefined,
				repository: REPOSITORY,
				persist: () => Service.persist(context.plan),
			} as unknown as Chat.Room;
		},
		instruct: (room, { handle, text, said, about }) => {
			planner.started++;
			return Chat.instruct(room, handle, text, said, about);
		},
		evict: room => Rooms.forget(room),
	};
	cleanups.push(() => {
		let room = Rooms.get(context.plan.id);
		if (room) Rooms.forget(room);
	});
	return {
		planner,
		start: (channelId: string, compose: (plan: Plan) => Instruction | undefined) =>
			serverInstruction(deps, channelId, compose),
		/** The answer turns Chat holds, and the notices it showed for them. */
		turns: () => context.plan.chat.waiting.map(item => item.text),
		notices: () =>
			context.plan.chat.entries
				.filter(entry => entry.author.kind === "system" && entry.text.includes(" answered "))
				.map(entry => entry.text),
	};
}

async function until(condition: () => boolean): Promise<void> {
	for (let waited = 0; !condition(); waited += 5) {
		if (waited > 3_000) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

/** Close the document and open it again over the same storage, as a restarted server does. */
async function restart(context: Awaited<ReturnType<typeof opened>>) {
	await Service.persist(context.plan);
	await Service.close(context.plan);
	plans = plans.filter(plan => plan !== context.plan);
	context.plan = await Service.open(context.plan.id, context.backend, context.server);
	plans.push(context.plan);
}

test("the turn names the question, the saved answer and who saved it, as data", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 }, "lee");

	let instruction = answerInstruction(context.plan, "turn-1", [{ id, generation: 1 }])!;

	expect(instruction.handle).toBe("chopin");
	expect(instruction.said).toBe('@lee answered "How should the wrong sentence be fixed?"');
	expect(instruction.text).toContain(JSON.stringify("How should the wrong sentence be fixed?"));
	expect(instruction.text).toContain(JSON.stringify("Start a new run (recommended)"));
	expect(instruction.text).toContain(JSON.stringify("A run makes the fix."));
	expect(instruction.text).toContain("@lee");
	expect(instruction.text).toContain("Act on it now");
	// Its passage has a write-up of its own, so the turn leaves that passage alone.
	expect(instruction.text).toContain("leave that passage");
	// The turn's notice carries its stable id, so a restart recognizes a turn already started.
	expect(instruction.about?.notice).toBe("turn-1");
	expect(instruction.about?.spent?.()).toBe(false);
});

test("a reopened decision's earlier answer is no longer handed over", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 });
	let instruction = answerInstruction(context.plan, "turn-1", [{ id, generation: 1 }])!;
	let actor = member();
	await Questions.reopen(context.plan, context.server, context.plan.id, actor.ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});

	expect(instruction.about?.spent?.()).toBe(true);
	expect(answerInstruction(context.plan, "turn-2", [{ id, generation: 1 }])).toBeUndefined();
	await context.save(id, { option: 1 });
	expect(context.told).toEqual([[id, 1], [id, 2]]);
	expect(answerInstruction(context.plan, "turn-3", [{ id, generation: 2 }])?.text)
		.toContain(JSON.stringify("Edit the sentence only"));
});

test("six answers saved in a burst start one turn that lists all six", async () => {
	let context = await opened();
	let { start, turns, notices } = planner(context);
	let answers = answerTurns({
		store: context.storage.decisionAnswers,
		start,
		window: { quietMs: 100, longestMs: 5_000 },
	});
	cleanups.push(() => answers.close());
	let ids: string[] = [];
	for (let n = 1; n <= 6; n++) ids.push(await captured(context, `Question number ${n}?`));
	for (let id of ids) await context.save(id, { option: 0 });

	for (let id of ids) await answers.answered(context.plan.id, id, 1);
	await until(() => turns().length > 0);
	await answers.pending(context.plan.id);

	expect(turns()).toHaveLength(1);
	for (let n = 1; n <= 6; n++) {
		expect(turns()[0]).toContain(JSON.stringify(`Question number ${n}?`));
	}
	expect(notices()).toEqual(["@ana answered 6 decisions"]);
	expect(await context.storage.decisionAnswers.pending(context.plan.id)).toEqual([]);
});

test("answers that keep arriving go in one turn once the first has waited the longest", async () => {
	let context = await opened();
	let { start, turns } = planner(context);
	let answers = answerTurns({
		store: context.storage.decisionAnswers,
		start,
		window: { quietMs: 200, longestMs: 400 },
	});
	cleanups.push(() => answers.close());
	let ids: string[] = [];
	for (let n = 1; n <= 3; n++) ids.push(await captured(context, `Question number ${n}?`));
	for (let id of ids) await context.save(id, { option: 0 });

	// One answer every 25 ms never leaves the quiet gap, so only the longest wait sends them.
	let reported = 0;
	let started = Date.now();
	while (!turns().length && Date.now() - started < 3_000) {
		await answers.answered(context.plan.id, ids[reported % ids.length]!, 1);
		reported++;
		await Bun.sleep(25);
	}

	expect(turns()).toHaveLength(1);
	expect(Date.now() - started).toBeLessThan(1_500);
	for (let n = 1; n <= 3; n++) {
		expect(turns()[0]).toContain(JSON.stringify(`Question number ${n}?`));
	}
});

test("an answer saved while a Planner turn runs joins the next turn", async () => {
	let context = await opened();
	let { start, turns, notices } = planner(context);
	let running: PromiseWithResolvers<void> | undefined;
	let answers = answerTurns({
		store: context.storage.decisionAnswers,
		start: async (channelId, compose) => {
			let accepted = await start(channelId, compose);
			// The answer turn now runs, until the test ends it.
			if (accepted === true) running = Promise.withResolvers<void>();
			return accepted;
		},
		busy: () => running?.promise,
		window: { quietMs: 20, longestMs: 1_000 },
	});
	cleanups.push(() => answers.close());
	let [first, second, third] = [
		await captured(context, "First?"),
		await captured(context, "Second?"),
		await captured(context, "Third?"),
	];

	await context.save(first!, { option: 0 });
	await answers.answered(context.plan.id, first!, 1);
	await answers.pending(context.plan.id);
	expect(turns()).toHaveLength(1);

	await context.save(second!, { option: 0 }, "lee");
	await answers.answered(context.plan.id, second!, 1);
	await Bun.sleep(100);
	await context.save(third!, { option: 1 });
	await answers.answered(context.plan.id, third!, 1);
	await Bun.sleep(100);
	// Nothing new starts while the turn runs.
	expect(turns()).toHaveLength(1);

	let ended = running!;
	running = undefined;
	ended.resolve();
	await until(() => turns().length > 1);

	expect(turns()).toHaveLength(2);
	expect(turns()[1]).toContain(JSON.stringify("Second?"));
	expect(turns()[1]).toContain(JSON.stringify("Third?"));
	expect(turns()[1]).not.toContain(JSON.stringify("First?"));
	expect(notices()).toEqual(['@ana answered "First?"', "@lee and @ana answered 2 decisions"]);
});

test("answers that found no Planner wait in storage and a restarted server delivers them once", async () => {
	let context = await opened();
	let first = await captured(context, "First?");
	let second = await captured(context, "Second?");
	let before = planner(context);
	before.planner.owner = false;
	let answers = answerTurns({
		store: context.storage.decisionAnswers,
		start: before.start,
		window: WINDOW,
	});
	await context.save(first, { option: 0 });
	await answers.answered(context.plan.id, first, 1);
	await context.save(second, { option: 1 });
	await answers.answered(context.plan.id, second, 1);
	await answers.pending(context.plan.id);
	expect(before.turns()).toEqual([]);
	answers.close();

	await restart(context);
	let after = planner(context);
	let restarted = answerTurns({
		store: context.storage.decisionAnswers,
		start: after.start,
		window: WINDOW,
	});
	cleanups.push(() => restarted.close());
	// An owner appears, and appears again.
	await restarted.pending(context.plan.id);
	await restarted.pending(context.plan.id);

	expect(after.turns()).toHaveLength(1);
	expect(after.turns()[0]).toContain(JSON.stringify("First?"));
	expect(after.turns()[0]).toContain(JSON.stringify("Second?"));
	expect(after.notices()).toEqual(["@ana answered 2 decisions"]);

	await restart(context);
	let again = planner(context);
	let third = answerTurns({ store: context.storage.decisionAnswers, start: again.start });
	cleanups.push(() => third.close());
	await third.pending(context.plan.id);
	expect(again.planner.started).toBe(0);
	expect(again.notices()).toEqual(["@ana answered 2 decisions"]);
});

test("a turn that started just before a crash, before it was marked delivered, never starts again", async () => {
	let context = await opened();
	let id = await captured(context);
	let before = planner(context);
	let store = context.storage.decisionAnswers;
	// The process dies between Chat accepting the turn and marking its answer delivered.
	let crashing: DecisionAnswerStore = {
		save: input => store.save(input),
		pending: channelId => store.pending(channelId),
		claim: (channelId, turnId, answers) => store.claim(channelId, turnId, answers),
		release: (channelId, turnId) => store.release(channelId, turnId),
		delivered: async () => {
			throw new Error("the process went away");
		},
	};
	let answers = answerTurns({ store: crashing, start: before.start, window: WINDOW });
	await context.save(id, { option: 0 });
	await answers.answered(context.plan.id, id, 1);
	await answers.pending(context.plan.id).catch(() => {});
	expect(before.planner.started).toBe(1);
	expect(before.notices()).toEqual(['@ana answered "How should the wrong sentence be fixed?"']);
	answers.close();

	await restart(context);
	let after = planner(context);
	let restarted = answerTurns({ store, start: after.start, window: WINDOW });
	cleanups.push(() => restarted.close());
	await restarted.pending(context.plan.id);

	expect(after.planner.started).toBe(0);
	expect(after.notices()).toEqual(['@ana answered "How should the wrong sentence be fixed?"']);
	expect(await store.pending(context.plan.id)).toEqual([]);
});

test("saving a decision again replaces its waiting answer, and reopening it cancels it", async () => {
	let context = await opened();
	let changed = await captured(context, "Changed?");
	let reopened = await captured(context, "Reopened?");
	let { start, turns, notices } = planner(context);
	let answers = answerTurns({ store: context.storage.decisionAnswers, start, window: WINDOW });
	cleanups.push(() => answers.close());
	let actor = member();
	let reopen = (id: string) =>
		Questions.reopen(context.plan, context.server, context.plan.id, actor.ws, {
			kind: "question:reopen",
			ts: 0,
			rid: `reopen-${id}`,
			id,
		});

	await context.save(changed, { option: 0 });
	await answers.answered(context.plan.id, changed, 1);
	await context.save(reopened, { option: 0 });
	await answers.answered(context.plan.id, reopened, 1);
	await reopen(changed);
	await context.save(changed, { option: 1 }, "lee");
	await answers.answered(context.plan.id, changed, 2);
	await reopen(reopened);
	await answers.pending(context.plan.id);

	expect(turns()).toHaveLength(1);
	expect(turns()[0]).toContain(JSON.stringify("Edit the sentence only"));
	expect(turns()[0]).not.toContain(JSON.stringify("Reopened?"));
	expect(notices()).toEqual(['@lee answered "Changed?"']);
	expect(await context.storage.decisionAnswers.pending(context.plan.id)).toEqual([]);
});

test("the same answer reported twice at once still starts a single turn", async () => {
	let context = await opened();
	let id = await captured(context);
	let { start, turns } = planner(context);
	let answers = answerTurns({ store: context.storage.decisionAnswers, start, window: WINDOW });
	cleanups.push(() => answers.close());
	await context.save(id, { option: 0 });

	await Promise.all([
		answers.answered(context.plan.id, id, 1),
		answers.answered(context.plan.id, id, 1),
	]);
	await Promise.all([answers.pending(context.plan.id), answers.pending(context.plan.id)]);
	await answers.answered(context.plan.id, id, 1);
	await answers.pending(context.plan.id);

	expect(turns()).toHaveLength(1);
});
