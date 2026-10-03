import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { message } from "./policy-initial.test-fixtures";
import {
	interpretLowOwnership,
	repeatQuestionCases,
	stateWithQuestion,
} from "./pipeline-recovery.test-fixtures";

test.each([
	{ id: "same-thread", targetKind: "same" },
	{ id: "ambiguous-target", targetKind: "none" },
])(
	"a repeated audit question does not open another thread for $id",
	async ({ id, targetKind }) => {
		let text = "Should audit logs go in PostgreSQL or object storage?";
		let existing = message("existing-audit-question", text);
		let threadId = "thread:existing-audit";
		let state = applyInference(initialState(), {
			id: "existing-audit-thread",
			type: "thread.opened",
			threadId,
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: existing.ts,
			source: {
				messageId: existing.id,
				author: existing.author as ConversationPlan.SourceAuthor,
				quote: text,
				start: 0,
				end: text.length,
				role: "question",
			},
			question: text,
		}, existing);
		let target = targetKind === "same" ? threadId : "none";
		let output = await interpretLowOwnership(`repeat-audit-${id}`, text, {
			weakFragments: false,
			state,
			triageTarget: target,
			candidateThreadTarget: target,
		});
		expect(output.events.some(event => event.type === "thread.opened")).toBe(false);
	},
);

test.each(repeatQuestionCases)(
	"a repeated audit question repairs only missing options on an $id despite a new target",
	async ({ id, existing, missing, duplicates }) => {
		let text = "Should audit logs go in PostgreSQL or object storage?";
		let threadId = "thread:existing-audit";
		let state = stateWithQuestion(threadId, text, existing);
		let output = await interpretLowOwnership(`repeat-audit-${id}`, text, {
			weakFragments: false,
			state,
			triageTarget: "new",
			candidateThreadTargets: { c0_thread: "new", c1_thread: "new" },
			candidateRoles: { c0_role: "question", c1_role: "option" },
			candidateDuplicates: duplicates,
		});
		let options = output.events.flatMap(event => event.type === "option.added" ? [event] : []);
		expect(output.analysis.passes[0]?.answers.thread_target).toMatchObject({
			type: "choice",
			choice: "new",
		});
		expect(output.events.some(event => event.type === "thread.opened")).toBe(false);
		expect(options.map(event => event.contribution.text)).toEqual([...missing]);
		expect(options.every(event => event.threadId === threadId)).toBe(true);
		expect(options.map(event => ({
			quote: event.source?.quote,
			start: event.source?.start,
			end: event.source?.end,
		}))).toEqual(missing.map(option => {
			let start = text.indexOf(option);
			return { quote: option, start, end: start + option.length };
		}));
	},
);

test.each([
	{ id: "matching-thread-target", target: "existing" },
	{ id: "mistaken-new-target", target: "new" },
])(
	"a low new-question score still recovers an empty exact match with $id",
	async ({ id, target }) => {
		let text = "Should audit logs go in PostgreSQL or object storage?";
		let options = ["PostgreSQL", "object storage"];
		let threadId = "thread:existing-audit-low-score";
		let state = stateWithQuestion(threadId, text);
		let targetId = target === "existing" ? threadId : "new";
		let output = await interpretLowOwnership(`repeat-audit-low-${id}`, text, {
			state,
			triageTarget: targetId,
			newQuestion: 0.5,
			candidateThreadTargets: { c0_thread: targetId, c1_thread: targetId },
		});
		let additions = output.events.flatMap(event => event.type === "option.added" ? [event] : []);
		expect(output.analysis.passes[0]?.answers.new_question).toMatchObject({
			type: "noul",
			noul: 0.5,
		});
		expect(output.analysis.passes[0]?.answers.act).toMatchObject({
			type: "choice",
			choice: "question",
		});
		expect(output.events.map(event => event.type)).toEqual([
			"option.added",
			"option.added",
		]);
		expect(additions.map(event => event.contribution.text)).toEqual(options);
		expect(additions.every(event => event.threadId === threadId)).toBe(true);
		expect(additions.map(event => ({
			quote: event.source?.quote,
			start: event.source?.start,
			end: event.source?.end,
		}))).toEqual(options.map(option => {
			let start = text.indexOf(option);
			return { quote: option, start, end: start + option.length };
		}));
	},
);
