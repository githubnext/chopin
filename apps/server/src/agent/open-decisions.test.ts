import { expect, test } from "bun:test";
import { documentTools } from "./tools";
import { askPlan, openDecisions } from "./arguments";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Room from "../plan/room";
import * as Store from "../questions/store";
import * as Question from "@chopin/question";
import { scopeSnapshot } from "../questions/decision-followup";
import { writeScope } from "../questions/decision-followup-write";
import { member } from "../questions/text-response.test-fixtures";
import type { DocumentRoom } from "./tools";

test("ask accepts a written decision without fabricated alternatives", () => {
	let question = {
		header: "Onboarding",
		question: "How should onboarding work?",
		response: "text" as const,
		multiple: false,
		options: [],
		blocks: [],
	};
	expect(askPlan({ revision: 0, questions: [question] }).questions[0]).toEqual(question);
	let { response: _response, ...choice } = question;
	expect(() => askPlan({ revision: 0, questions: [choice] })).toThrow(
		"requires at least one option",
	);
	expect(() =>
		openDecisions({
			revision: 0,
			questions: [{ ...question, key: "onboarding", answer: "Use a tour" }],
		})
	)
		.toThrow("unexpected field");
});

test("one anchored capture returns promptly and its saved answer updates only its durable scope", async () => {
	let fixture = await openPlan(
		"Neither default has been chosen.\n\nKeep this unrelated paragraph.",
	);
	let anchors = 0;
	let room: DocumentRoom = {
		id: fixture.plan.id,
		plan: fixture.plan,
		server: fixture.server,
		persist: () => Service.persist(fixture.plan),
		exclusive: action => Service.exclusive(fixture.plan, action),
		publish: async () => {},
		anchors: () => {
			anchors++;
		},
		changes: () => {},
		visualAdmission: async () => [],
	};
	let options = { toolCallId: "open-one", messages: [], context: { room } };
	let input = {
		revision: 0,
		questions: [{
			key: "first-arrival",
			header: "Order",
			question: "Which order should Margin use on first arrival?",
			response: "text",
			multiple: false,
			options: [],
			blocks: [{ index: 0, digest: Room.digests(fixture.plan.document)[0]! }],
		}],
	};
	try {
		let first = await documentTools.open_decisions.execute!(input, options as never);
		expect(JSON.parse(first as string).decisions).toMatchObject([{ status: "open" }]);
		expect(fixture.plan.records.size).toBe(1);
		expect(anchors).toBe(1);
		let again = await documentTools.open_decisions.execute!(input, options as never);
		expect(again).toEqual(first);
		let stale = await documentTools.open_decisions.execute!(
			{ ...input, questions: [{ ...input.questions[0]!, key: "new-decision" }] },
			options as never,
		);
		expect(stale).toContain("changed");
		expect(fixture.plan.records.size).toBe(1);
		let id = JSON.parse(first as string).decisions[0].id as string;
		let { ws } = member();
		let entry = Store.get(fixture.plan.questions, id)!;
		let fork = entry.model.fork() as Question.Model;
		fork.api.str([entry.definition.questions[0]!.id, "custom"]).ins(0, "Recently edited");
		await Questions.edit(fixture.plan, ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit-one",
			id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(fixture.plan, fixture.server, fixture.plan.id, ws, {
			kind: "question:submit",
			ts: 0,
			rid: "save-one",
			id,
			revision: Store.get(fixture.plan.questions, id)!.revision,
		});
		expect(fixture.plan.conversationPlanPendingEffects).toContainEqual({
			key: `job:decision-followup:${id}:1`,
			kind: "job",
			intent: { kind: "decision-followup", target: id, trigger: `decided:${id}:1` },
		});
		await Service.close(fixture.plan);
		fixture.plan = await Service.open(fixture.plan.id, fixture.backend, fixture.server);
		room.plan = fixture.plan;
		let snapshot = scopeSnapshot(fixture.plan, id);
		let job = {
			id: `decision-followup:${id}`,
			kind: "decision-followup" as const,
			target: id,
			trigger: `decided:${id}:1`,
			status: "running" as const,
			attempts: 0,
			at: fixture.now.toISOString(),
		};
		fixture.plan.chat.job = job;
		await writeScope(room, job, fixture.plan.chat.turn, {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Margin opens in Recently edited order.",
		});
		let source = Room.project(fixture.plan.document);
		expect(source).toContain("Margin opens in Recently edited order.");
		expect(source).toContain("Keep this unrelated paragraph.");
		expect(source).not.toContain("Neither default has been chosen.");
		await Questions.discard(fixture.plan, fixture.server, fixture.plan.id, ws, {
			kind: "question:discard",
			ts: 0,
			rid: "discard-one",
			id,
		});
		let settled = await documentTools.open_decisions.execute!(input, options as never);
		expect(JSON.parse(settled as string).decisions).toEqual([{
			key: "first-arrival",
			id,
			status: "discarded",
		}]);
	} finally {
		await Service.close(fixture.plan);
	}
});
