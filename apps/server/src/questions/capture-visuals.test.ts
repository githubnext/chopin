import { afterEach, expect, test } from "bun:test";
import * as Question from "@chopin/question";
import * as Room from "../plan/room";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { captureDecisions } from "./service-capture";
import { scopeSnapshot } from "./decision-followup";
import { writeScope } from "./decision-followup-write";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];
afterEach(async () => {
	for (let context of contexts) await Plan.close(context.plan);
	contexts = [];
});

let table = "| Approach | Benefit |\n| --- | --- |\n| Existing | Stable |";
function question(plan: Plan.Plan, key: string) {
	return {
		key,
		header: "Approach",
		question: "How should the approaches compare?",
		response: "text" as const,
		options: [],
		multiple: false,
		blocks: [{ index: 0, digest: Room.digests(plan.document)[0]! }],
	};
}

test("capture keeps a paragraph and its existing native visual together before the card", async () => {
	let context = await openPlan(`Compare the approaches.\n\n${table}`);
	contexts.push(context);
	let result = await captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one")],
	});
	let id = result.decisions[0]!.id;
	let record = context.plan.records.get(id)!;
	expect(Room.questionnaireIndex(context.plan.document, id)).toBe(2);
	expect(record.followUp!.target).toHaveLength(2);
	expect(Room.matchesAnchor(context.plan.document, record.followUp!.target[0]!, 0)).toBe(true);
	expect(Room.matchesAnchor(context.plan.document, record.followUp!.target[1]!, 1)).toBe(true);
	let questionId = record.definition.questions[0]!.id;
	expect(record.anchors!.questions[questionId]!.anchors).toHaveLength(1);
	expect(
		Room.matchesAnchor(
			context.plan.document,
			record.anchors!.questions[questionId]!.anchors[0]!,
			0,
		),
	)
		.toBe(true);
});

test("re-anchoring keeps native visuals before the decision card", async () => {
	let context = await openPlan(`Compare the approaches.\n\n${table}`);
	contexts.push(context);
	let result = await captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one")],
	});
	let id = result.decisions[0]!.id;
	let digests = Room.digests(context.plan.document);
	let mutation = Questions.place(context.plan, [{
		widget: id,
		blocks: [{ index: 0, digest: digests[0]! }, { index: 1, digest: digests[1]! }],
	}]);
	if (mutation) await Plan.publish(context.plan, context.server, context.plan.id, mutation);
	expect(Room.questionnaireIndex(context.plan.document, id)).toBe(2);
	expect(Room.project(context.plan.document)).toStartWith(
		"Compare the approaches.\n\n| Approach |",
	);
});

test("repairing one historical placement moves its interleaved peer group after the visual", async () => {
	let context = await openPlan(`Compare the approaches.\n\n${table}`);
	contexts.push(context);
	let result = await captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one"), question(context.plan, "decision-two")],
	});
	let [first, second] = result.decisions.map(decision => decision.id);
	let at = { index: 0, digest: Room.digests(context.plan.document)[0]! };
	let historical = Room.placeQuestionnaires(context.plan.document, [
		{ id: first!, at },
		{ id: second!, at, after: first! },
	]);
	if (historical) await Plan.publish(context.plan, context.server, context.plan.id, historical);
	let mutation = Questions.place(context.plan, [{ widget: second!, blocks: [at] }]);
	if (mutation) await Plan.publish(context.plan, context.server, context.plan.id, mutation);
	expect(Room.questionnaireIndex(context.plan.document, first!)).toBe(2);
	expect(Room.questionnaireIndex(context.plan.document, second!)).toBe(3);
	expect(Room.project(context.plan.document)).toStartWith(
		"Compare the approaches.\n\n| Approach |",
	);
});

test("a later peer card stays after the visual added by a saved-answer continuation", async () => {
	let context = await openPlan("The approach remains provisional.");
	contexts.push(context);
	let first = await captureDecisions(context.plan, context.server, context.plan.id, {
		revision: 0,
		questions: [question(context.plan, "decision-one")],
	});
	let id = first.decisions[0]!.id;
	let actor = member();
	let entry = Store.get(context.plan.questions, id)!;
	let fork = entry.model.fork() as Question.Model;
	fork.api.str([entry.definition.questions[0]!.id, "custom"]).ins(
		0,
		"Compare the existing approach.",
	);
	await Questions.edit(context.plan, actor.ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
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
	let job = {
		id: "followup",
		kind: "decision-followup" as const,
		target: id,
		trigger: `decided:${id}:1`,
		status: "running" as const,
		attempts: 0,
		at: context.now.toISOString(),
	};
	context.plan.chat.job = job;
	let room = {
		id: context.plan.id,
		plan: context.plan,
		server: context.server,
		exclusive: <T>(action: () => Promise<T>) => Plan.exclusive(context.plan, action),
		anchors() {},
		changes() {},
		visualAdmission: async () => [],
	} as unknown as import("../agent/tools").DocumentRoom;
	let snapshot = scopeSnapshot(context.plan, id);
	await writeScope(room, job, context.plan.chat.turn, {
		id,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source: `Compare the approaches.\n\n${table}`,
	});
	let next = await captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [question(context.plan, "decision-two")],
	});
	let peer = context.plan.records.get(next.decisions[0]!.id)!;
	expect(peer.followUp!.scope).toBe(context.plan.records.get(id)!.followUp!.scope);
	expect(Room.questionnaireIndex(context.plan.document, peer.id)).toBe(2);
	expect(scopeSnapshot(context.plan, id).indices).toEqual([0, 1]);
});
