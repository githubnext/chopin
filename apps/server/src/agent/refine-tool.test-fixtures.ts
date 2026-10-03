import { afterEach, expect } from "bun:test";
import { toolbox } from "./scoped-tools.test-bridge";
import { applyEvent } from "../conversation-plan/events";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import type { Chat, ConversationPlan } from "@chopin/protocol";

function job(
	plan: Awaited<ReturnType<typeof Service.open>>,
	id: string,
	kind: "refine" | "suggest" = "refine",
) {
	plan.chat.job = {
		id: `${kind}:${id}:m1`,
		kind,
		target: id,
		trigger: "m1",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

export function createRefineToolFixture(
	readContexts: () => Awaited<ReturnType<typeof openPlan>>[],
	writeContexts: (value: Awaited<ReturnType<typeof openPlan>>[]) => void,
) {
	const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

	let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];

	async function opened(options: Array<{ id: string; label: string }> = []) {
		let context = await openPlan("Opening prose.\n\nLater prose.\n");
		contexts.push(context);
		let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId: "thread-a",
			header: "Authentication",
			question: "What auth system should we use?",
			options,
		});
		return { ...context, id };
	}

	function tool(
		context: Awaited<ReturnType<typeof openPlan>>,
		exclusive = Service.exclusive,
	) {
		let found = toolbox({
			plan: context.plan,
			server: context.server,
			room: "test",
			persist: () => Service.persist(context.plan),
			exclusive: action => exclusive(context.plan, action),
			async publish() {},
			anchors() {},
			changes() {},
		}).find(item => item.name === "refine_decision");
		if (!found?.handler) throw new Error("refine_decision is missing");
		return found.handler;
	}

	async function call(
		context: Awaited<ReturnType<typeof openPlan>>,
		input: Record<string, unknown>,
		exclusive = Service.exclusive,
	) {
		return String(await tool(context, exclusive)(input, {} as never));
	}

	function source(entry: Chat.Entry, quote: string): ConversationPlan.SourceRef {
		let start = entry.text.indexOf(quote);
		if (start < 0) throw new Error("quote missing from test message");
		return {
			messageId: entry.id,
			author: entry.author as ConversationPlan.SourceAuthor,
			quote,
			start,
			end: start + quote.length,
			role: "option",
		};
	}

	function linkQuestion(
		context: Awaited<ReturnType<typeof openPlan>> & { id: string },
		ref: ConversationPlan.SourceRef,
	) {
		let opened = applyEvent(context.plan.conversationPlan, {
			id: "open-question",
			type: "thread.opened",
			threadId: "thread-a",
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 1,
			source: ref,
			question: "Lexical or ProseMirror?",
		});
		context.plan.conversationPlan = applyEvent(opened, {
			id: "link-question",
			type: "card.linked",
			threadId: "thread-a",
			observedThreadVersion: 1,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 2,
			questionnaireId: context.id,
		});
	}

	function d01Messages(context: Awaited<ReturnType<typeof openPlan>> & { id: string }) {
		let m1: Chat.Entry = {
			id: "d01-m1",
			author: { kind: "member", handle: "Nia" },
			text: "need to pick an editor before comments get any deeper. what are we comparing?",
			ts: 1,
		};
		let m2: Chat.Entry = {
			id: "d01-m2",
			author: { kind: "member", handle: "Rob" },
			text:
				"Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
			ts: 2,
		};
		context.plan.chat.entries.push(m1, m2);
		let ref = { ...source(m1, m1.text), role: "question" as const };
		linkQuestion(context, ref);
		return { m1, m2, ref };
	}

	async function expectExplicitSourceNotAuthoritative(entry: Chat.Entry, quote: string) {
		let context = await opened();
		context.plan.chat.entries.push(entry);
		job(context.plan, context.id);
		let citation = source(entry, quote);
		let before = room.project(context.plan.document);
		let response = await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [{
				label: "Tiptap",
				rationale: "Candidate source for the Tiptap option.",
				source: citation,
			}],
		});
		let record = context.plan.records.get(context.id)!;
		if (response.includes("Error")) {
			expect(room.project(context.plan.document)).toBe(before);
			expect(record.definition.questions[0]?.options).toEqual([]);
			return;
		}

		let answer = JSON.parse(response) as { added: string[] };
		expect(answer.added).toHaveLength(1);
		let id = answer.added[0]!;
		expect(record.optionOrigins[id]?.source).toBeUndefined();
		let event = context.plan.conversationPlan.events.find(event =>
			event.type === "option.added" && event.contribution.id === id
		);
		expect(event?.type === "option.added" ? event.source : undefined).toBeUndefined();
	}

	let cleanup = async () => {
		for (let context of contexts) await Service.close(context.plan);
		contexts = [];
	};
	afterEach(async () => {
		contexts = readContexts();
		try {
			await cleanup();
		} finally {
			writeContexts(contexts);
		}
	});
	return {
		OPTION,
		contexts,
		opened,
		job,
		tool,
		call,
		source,
		linkQuestion,
		d01Messages,
		expectExplicitSourceNotAuthoritative,
	};
}
