import { afterEach } from "bun:test";
import { questionnaireElement, serialize, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { Plan } from "../plan/service";
import type { Socket } from "../wire";

let plans = new Set<Plan>();
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans.clear();
});

export function member(handle = "ana") {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle, client: `client-${handle}`, room: "test" },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	return { ws, frames };
}

export function seed() {
	let id = ulid();
	let questionId = ulid();
	let definition = Question.decision({
		questions: [{
			id: questionId,
			header: "Onboarding",
			question: "How should onboarding work?",
			description: "Help people learn by doing.",
			response: "text",
			multiple: false,
			options: [],
		}],
	});
	let source = serialize({
		type: "root",
		children: [questionnaireElement({
			id,
			status: "open",
			questions: [{
				id: questionId,
				header: "Onboarding",
				prompt: "How should onboarding work?",
				description: "Help people learn by doing.",
				response: "text",
				multiple: false,
				options: [],
			}],
		})],
	});
	let model = Question.create(definition);
	return {
		id,
		questionId,
		definition,
		source,
		record: { id, definition, origin: "human", owner: "ana", editors: ["ana"], status: "open" },
		open: { id, definition, widget: id, model: [...model.toBinary()], revision: 0 },
	};
}

export async function opened() {
	let value = seed();
	let context = await openPlan(value.source, {
		questions: [value.record],
		openQuestions: [value.open],
	});
	plans.add(context.plan);
	return { ...context, ...value };
}

export async function restart(context: Awaited<ReturnType<typeof opened>>, plan = context.plan) {
	await Service.close(plan);
	plans.delete(plan);
	let next = await Service.open(context.channel.id, context.backend, context.server);
	plans.add(next);
	return next;
}
