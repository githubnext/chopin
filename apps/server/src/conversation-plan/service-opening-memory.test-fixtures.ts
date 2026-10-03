import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan, storedQuestion } from "../testing/plan";

export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	let promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

export async function storedLegacy() {
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
	await Service.close(context.plan);
	return { ...context, id, source };
}
