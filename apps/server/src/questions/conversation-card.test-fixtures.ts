import { afterEach } from "bun:test";
import * as Questions from "./service";
import { initialState } from "../conversation-plan/domain";
import { applyEvent } from "../conversation-plan/events";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";

function input(options: Array<{ id: string; label: string }> = []) {
	return {
		threadId: "thread-a",
		header: "Authentication",
		question: "What auth system should we use?",
		options,
	};
}

function source(handle: string): ConversationPlan.SourceRef {
	return {
		messageId: `message-${handle}`,
		author: { kind: "member", handle },
		quote: "Auth",
		start: 0,
		end: 4,
		role: "question",
	};
}

// Exact archive helpers/callback; synchronous per-suite lexical binding wrapper.
export function createConversationCardFixture(
	readPlans: () => Plan[],
	writePlans: (value: Plan[]) => void,
) {
	const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

	const SECOND = "01K0N4W3B7P27CBAEC7A8C8WEB";

	let plans: Plan[] = [];

	async function quotedOption() {
		let context = await openPlan();
		plans.push(context.plan);
		let id = await Questions.insertConversationCard(
			context.plan,
			context.server,
			"test",
			input([
				{ id: OPTION, label: "We should use GitHub Apps for auth" },
				{ id: SECOND, label: "Use OAuth" },
			]),
		);
		let message = {
			id: "quoted-option-message",
			author: { kind: "member" as const, handle: "ana" },
			text: "We should use GitHub Apps for auth",
			ts: 1,
		};
		context.plan.chat.entries.push(message);
		let state = applyEvent(initialState(), {
			id: "opened",
			type: "thread.opened",
			threadId: "thread-a",
			observedThreadVersion: 0,
			origin: "planner",
			actor: { kind: "agent" },
			at: 1,
			question: "What auth system should we use?",
		});
		state = applyEvent(state, {
			id: "quoted",
			type: "option.added",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 2,
			source: {
				messageId: message.id,
				author: message.author,
				quote: message.text,
				start: 0,
				end: message.text.length,
				role: "option",
			},
			contribution: {
				id: OPTION,
				text: message.text,
				authoring: "quoted",
				targetId: "thread-a",
			},
		});
		state = applyEvent(state, {
			id: "second",
			type: "option.added",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: 3,
			contribution: { id: SECOND, text: "Use OAuth", authoring: "scribe", targetId: "thread-a" },
		});
		state = applyEvent(state, {
			id: "linked",
			type: "card.linked",
			threadId: "thread-a",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 4,
			questionnaireId: id,
		});
		context.plan.conversationPlan = state;
		return { context, id, state };
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
	return { OPTION, SECOND, plans, input, source, quotedOption };
}
