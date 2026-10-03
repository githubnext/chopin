import { afterEach } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Questions from "./service";
import * as Service from "../plan/service";
import { applyEvent } from "../conversation-plan/events";
import { initialState } from "../conversation-plan/domain";
import { openPlan } from "../testing/plan";

function ref(
	messageId: string,
	text: string,
	role: ConversationPlan.SourceRole = "question",
): ConversationPlan.SourceRef {
	return {
		messageId,
		author: { kind: "member", handle: "ana" },
		quote: text,
		start: 0,
		end: text.length,
		role,
	};
}

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
export function createSourceFixture(
	readPlans: () => Service.Plan[],
	writePlans: (value: Service.Plan[]) => void,
) {
	const OPTION_A = "01K0N4W3B7P27CBAEC7A8C8WEA";

	const OPTION_B = "01K0N4W3B7P27CBAEC7A8C8WEB";

	let plans: Service.Plan[] = [];

	async function linkQuestion(
		context: Awaited<ReturnType<typeof openPlan>>,
		id: string,
		threadId: string,
		questionSource: ConversationPlan.SourceRef,
	) {
		let message = {
			id: questionSource.messageId,
			author: questionSource.author,
			text: questionSource.quote,
			ts: 1,
		};
		context.plan.chat.entries.push(message);
		let state = applyEvent(initialState(), {
			id: `${threadId}:opened`,
			type: "thread.opened",
			threadId,
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1,
			source: questionSource,
			question: questionSource.quote,
		});
		state = applyEvent(state, {
			id: `${threadId}:linked`,
			type: "card.linked",
			threadId,
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 2,
			questionnaireId: id,
		});
		let earlier = context.plan.conversationPlan;
		context.plan.conversationPlan = {
			...earlier,
			revision: earlier.revision + state.revision,
			events: [...earlier.events, ...state.events],
			threads: [...earlier.threads, ...state.threads],
		};
	}

	async function conversationCard(
		context: Awaited<ReturnType<typeof openPlan>>,
		threadId: string,
		question: string,
	) {
		let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId,
			header: "Authentication",
			question,
			options: [],
		});
		let questionSource = ref(`message-${threadId}`, question);
		await linkQuestion(context, id, threadId, questionSource);
		return { id, questionSource };
	}
	let cleanup = async () => {
		for (let plan of plans) await Service.close(plan);
		plans = [];
	};
	afterEach(async () => {
		plans = readPlans();
		try {
			await cleanup();
		} finally {
			writePlans(plans);
		}
	});
	return { OPTION_A, OPTION_B, plans, ref, linkQuestion, conversationCard };
}
