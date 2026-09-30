import { afterEach } from "bun:test";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import * as Questions from "./service";

import type { Socket } from "../wire";
import type { Plan } from "../plan/service";
import type { Definition } from "@chopin/question";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 helpers and cleanup.
export let plans: Plan[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

export function member(handle = "ben") {
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

export function definition(count = 1): Definition {
	return Questions.identify({
		questions: Array.from({ length: count }, (_, index) => ({
			header: `Choice ${index + 1}`,
			question: `Which choice ${index + 1}?`,
			multiple: false,
			options: [{ label: `Option ${index + 1}`, description: "" }],
		})),
	});
}

export function source(
	id: string,
	value: Definition,
	answers: { [question: string]: string },
	chosen: string[],
) {
	let selected = new Set(chosen);
	return `<Questionnaire id="${id}" status="decided" by="ana" at="2026-09-23T17:30:00.000Z">\n`
		+ value.questions.map(question => {
			let options = question.options.map(option =>
				`<Option id="${option.id}" label="${option.label}" />`
			).join("\n");
			let choices = question.options.filter(option => selected.has(option.id)).map(option =>
				option.id
			);
			let answer = `<Answer value="${answers[question.id]}"${
				choices.length ? ` choices="${choices.join(" ")}"` : ""
			} />`;
			return `<Question id="${question.id}" header="${question.header}" `
				+ `prompt="${question.question}" multiple="${question.multiple}">\n`
				+ `${options}\n${answer}\n</Question>`;
		}).join("\n")
		+ "\n</Questionnaire>\n";
}

export async function decided(
	value = definition(),
	answers?: { [question: string]: string },
	chosen?: string[],
) {
	let id = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
	let text = answers ?? Object.fromEntries(value.questions.map(question => [
		question.id,
		question.options[0]!.label,
	]));
	let ids = chosen ?? value.questions.map(question => question.options[0]!.id);
	let context = await openPlan(source(id, value, text, ids), {
		questions: [{
			id,
			definition: value,
			status: "answered",
			answers: text,
			choices: ids,
			resolver: "ana",
			at: 1,
			owner: "ana",
			decidedAt: 1,
		}],
	});
	plans.push(context.plan);
	return { ...context, id, value };
}

export async function reopen(
	context: Awaited<ReturnType<typeof decided>>,
	member = memberFactory(),
) {
	await Questions.reopen(context.plan, context.server, "test", member.ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id: context.id,
	});
	return member;
}

export function memberFactory() {
	return member();
}
