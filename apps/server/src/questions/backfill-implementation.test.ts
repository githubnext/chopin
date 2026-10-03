import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan, storedQuestion } from "../testing/plan";
import { backfillPlannerAskThreads } from "./backfill";
import * as Questions from "./service";

test("legacy backfill refuses an implementation claim without publishing or persisting links", async () => {
	let id = ulid();
	let definition = Questions.identify({
		questions: [{
			header: "Storage",
			question: "Where should data live?",
			multiple: false,
			options: [{ label: "PostgreSQL", description: "Shared." }],
		}],
	});
	let question = definition.questions[0]!;
	let document = await room.create();
	let source: string;
	try {
		room.insertQuestionnaire(document, {
			id,
			questions: [{
				id: question.id,
				header: question.header,
				prompt: question.question,
				multiple: question.multiple,
				options: question.options,
			}],
		});
		source = room.project(document);
	} finally {
		document.doc.destroy();
	}
	let context = await openPlan(source, {
		questions: [{
			id,
			definition,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		}],
		openQuestions: [{
			id,
			definition: Question.decision(definition),
			widget: id,
			model: storedQuestion(Question.decision(definition)),
			revision: 0,
		}],
	});
	let { plan } = context;
	try {
		let revision = plan.persistence.revision;
		plan.claiming = true;
		await expect(backfillPlannerAskThreads(plan)).rejects.toThrow("implementation is active");
		expect(plan.persistence.revision).toBe(revision);
		expect(plan.records.get(id)?.threadId).toBeUndefined();
		expect(plan.conversationPlan.events).toEqual([]);
		expect(room.project(plan.document)).toBe(source);
		expect(context.broadcasts).toEqual([]);
	} finally {
		plan.claiming = false;
		await Service.close(plan);
	}
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(reopened.records.get(id)?.threadId).toBeUndefined();
		expect(reopened.conversationPlan.events).toEqual([]);
		expect(room.project(reopened.document)).toBe(source);
		expect(await backfillPlannerAskThreads(reopened)).toBe(1);
	} finally {
		await Service.close(reopened);
	}
});
