import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as Anchors from "./anchors";

import { applyEvent } from "../conversation-plan/events";

import { MAX_EVENTS, MAX_THREADS } from "../conversation-plan/validation";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast } from "../wire";
import type { Server } from "bun";

import type { DecisionDefinition, Definition } from "@chopin/question";
import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";
import type { Ended } from "./store";
import type { Record } from "./records";

import { announce } from "./card-notifications";
import { type AskPlacement, validatePlacement } from "./service-definition";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	placement?: AskPlacement,
	created?: () => void,
): Promise<Ended[]> {
	if (Service.implementationActive(plan)) throw new Error("implementation is active");
	if (definition.questions.length === 0) {
		Question.reject("A questionnaire needs at least one question");
	}
	let asked: Array<{
		id: string;
		single: DecisionDefinition;
		value: room.QuestionnaireInsertion["value"];
		waiting: Promise<Ended>;
		at: room.QuestionnaireInsertion["at"];
	}> = [];
	await Service.exclusive(plan, async () => {
		let anchors = placement ? validatePlacement(plan, definition, placement) : undefined;
		if (plan.conversationPlan.threads.length + definition.questions.length > MAX_THREADS) {
			throw new Error("conversation thread limit reached");
		}
		let eventCount = definition.questions.reduce(
			(count, question) => count + question.options.length + 2,
			plan.conversationPlan.events.length,
		);
		if (eventCount > MAX_EVENTS) throw new Error("conversation event limit reached");
		let conversationPlan = plan.conversationPlan;
		asked = definition.questions.map((question, index) => {
			let single = Question.decision({ questions: [question] });
			// Widget and question identities are deliberately distinct.
			let id = ulid();
			let threadId = ulid();
			let at = Math.floor(Date.now() / 1_000);
			conversationPlan = applyEvent(conversationPlan, {
				id: `ask:${id}:opened`,
				type: "thread.opened",
				threadId,
				observedThreadVersion: 0,
				origin: "planner",
				actor: { kind: "agent" },
				at,
				question: question.question,
			});
			for (let option of question.options) {
				let version = conversationPlan.threads.find(thread => thread.id === threadId)!.version;
				conversationPlan = applyEvent(conversationPlan, {
					id: `ask:${id}:option:${option.id}`,
					type: "option.added",
					threadId,
					observedThreadVersion: version,
					origin: "planner",
					actor: { kind: "agent" },
					at,
					contribution: {
						id: option.id,
						text: option.label,
						authoring: "scribe",
						targetId: threadId,
					},
				});
			}
			conversationPlan = applyEvent(conversationPlan, {
				id: `ask:${id}:linked`,
				type: "card.linked",
				threadId,
				observedThreadVersion: conversationPlan.threads.find(thread =>
					thread.id === threadId
				)!.version,
				origin: "classifier",
				actor: { kind: "classifier" },
				at,
				questionnaireId: id,
			});
			let waiting = Store.ask(plan.questions, id, single, id);
			let value = {
				id,
				thread: threadId,
				questions: [{
					id: question.id,
					header: question.header,
					prompt: question.question,
					multiple: question.multiple,
					options: question.options.map(option => ({
						id: option.id,
						label: option.label,
						...(option.description ? { description: option.description } : {}),
					})),
				}],
			};
			let record: Record = {
				id,
				definition: single,
				status: "open",
				origin: "planner",
				threadId,
				history: [],
				optionOrigins: {},
				editors: [],
			};
			if (anchors) {
				record.anchors = Anchors.set(Anchors.read(record), question.id, anchors[index]!);
			}
			plan.records.set(id, record);
			return { id, single, value, waiting, at: placement?.blocks[index]?.[0] };
		});
		plan.conversationPlan = conversationPlan;

		let mutation = room.insertQuestionnaires(
			plan.document,
			asked.map(item => ({
				value: item.value,
				...(item.at ? { at: item.at } : {}),
			})),
		);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
		for (let item of asked) {
			announce(plan, server, roomId, item.id);
			broadcast(server, roomId, {
				kind: "question:asked",
				ts: 0,
				id: item.id,
				definition: item.single,
				widget: item.id,
			});
		}
		created?.();
	});

	return Promise.all(asked.map(item => item.waiting));
}
