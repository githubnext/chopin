/** Link legacy open Planner questions to conversation threads before room exposure. */

import { ULID } from "@chopin/dialect";
import * as Y from "yjs";

import { applyEvent, assertEventCapacity } from "../conversation-plan/events";
import * as room from "../plan/room";
import * as Service from "../plan/service";

import type { Questionnaire } from "@chopin/dialect";
import type { ConversationPlan } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { Record } from "./records";

function matches(record: Record, projections: Questionnaire[]): boolean {
	if (
		record.origin !== "planner" || record.status !== "open" || record.history.length !== 0
		|| record.threadId || record.definition.questions.length !== 1
		|| Object.values(record.optionOrigins).some(origin => origin.origin !== "planner")
	) return false;
	let matching = projections.filter(value => value.id === record.id);
	if (matching.length !== 1) return false;
	let value = matching[0]!;
	let question = record.definition.questions[0]!;
	let projected = value.questions[0];
	return !value.thread && (value.status === undefined || value.status === "open")
		&& !value.by && !value.at && value.questions.length === 1 && !!projected
		&& projected.answer === undefined && projected.choices === undefined
		&& projected.previous === undefined
		&& projected.id === question.id && projected.header === question.header
		&& projected.prompt === question.question && projected.multiple === question.multiple
		&& projected.options.length === question.options.length
		&& projected.options.every((option, index) => {
			let expected = question.options[index]!;
			return option.id === expected.id && option.label === expected.label
				&& (option.description ?? "") === (expected.description ?? "");
		});
}

function eventsFor(
	state: ConversationPlan.State,
	record: Record,
	threadId: string,
): ConversationPlan.State {
	let at = 0;
	let question = record.definition.questions[0]!;
	let next = applyEvent(state, {
		id: `backfill:${record.id}:opened`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at,
		question: question.question,
	});
	for (let option of question.options) {
		let version = next.threads.find(thread => thread.id === threadId)!.version;
		next = applyEvent(next, {
			id: `backfill:${record.id}:option:${option.id}`,
			type: "option.added",
			threadId,
			observedThreadVersion: version,
			origin: "planner",
			actor: { kind: "agent" },
			at,
			contribution: { id: option.id, text: option.label, authoring: "scribe", targetId: threadId },
		});
	}
	return applyEvent(next, {
		id: `backfill:${record.id}:linked`,
		type: "card.linked",
		threadId,
		observedThreadVersion: next.threads.find(thread => thread.id === threadId)!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at,
		questionnaireId: record.id,
	});
}

/** Safe to retry: every surviving link is fixed by the card's persisted identity. */
export function backfillPlannerAskThreads(plan: Plan): Promise<number> {
	return Service.exclusive(plan, async () => {
		let projections = room.questionnaireProjections(plan.document);
		let records = new Map(plan.records);
		let conversationPlan = plan.conversationPlan;
		let links: Array<{ id: string; threadId: string }> = [];
		for (let record of [...plan.records.values()].toSorted((a, b) => a.id.localeCompare(b.id))) {
			if (!matches(record, projections) || !ULID.test(record.id)) continue;
			let threadId = `planner-ask:${record.id}`;
			if (
				[...plan.records.values()].some(other => other.threadId === threadId)
				|| projections.some(value => value.thread === threadId)
			) continue;
			try {
				let next = eventsFor(conversationPlan, record, threadId);
				assertEventCapacity(next, plan.pendingCardActions.length);
				if (
					next === conversationPlan
					|| !next.threads.some(thread =>
						thread.id === threadId && thread.questionnaireId === record.id
					)
				) continue;
				conversationPlan = next;
				records.set(record.id, { ...record, threadId });
				links.push({ id: record.id, threadId });
			} catch {
				// A collision or exhausted conversation limit must not block another safe card.
			}
		}
		if (links.length === 0) return 0;
		let stagedDocument = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		stagedDocument.seq = plan.document.seq;
		try {
			let mutation = room.linkQuestionnaireThreads(stagedDocument, links);
			if (!mutation) throw new Error("Planner card backfill produced no document update");
			// A thread attribute changes MDX without adding prose for the summary model.
			await Service.publishStaged(
				plan,
				plan.server,
				plan.id,
				{
					...plan,
					document: stagedDocument,
					records,
					conversationPlan,
				},
				mutation,
				{ notifyDocumentPersisted: false },
			);
			return links.length;
		} finally {
			stagedDocument.doc.destroy();
		}
	});
}
