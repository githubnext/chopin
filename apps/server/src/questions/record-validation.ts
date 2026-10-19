import type { ConversationPlan, Plan as Wired, Question } from "@chopin/protocol";
import { limits } from "@chopin/question";
import { assertSourceShape } from "../conversation-plan/sources";
import type { DecisionEntry, Record } from "./record-types";
import { invalid, object, ORIGINS, text, unix } from "./record-fields";
import type { Known } from "./record-fields";

export function options(definition: unknown, pending: boolean): Known {
	let source = object(definition);
	if (
		!Array.isArray(source.questions) || source.questions.length === 0
		|| source.questions.length > limits.MAX_QUESTIONS
			&& !source.questions.every(question => object(question).verbatim === true)
	) invalid();
	let ids = new Map<string, string>();
	let questions: Known["questions"] = new Map();
	for (let candidate of source.questions) {
		let question = object(candidate);
		let id = text(question.id);
		if (questions.has(id)) invalid();
		// Host dialogs keep their raw text and counts, so only the Planner's questions are bounded.
		let verbatim = question.verbatim === true;
		if (
			Object.hasOwn(question, "response")
			&& (question.response !== "text" || verbatim || question.multiple !== false)
		) invalid();
		if (
			typeof question.multiple !== "boolean"
			|| !Array.isArray(question.options)
			|| question.options.length === 0 && !verbatim && question.response !== "text"
				&& !(pending && source.questions.length === 1 && question.multiple === false)
			|| question.response === "text" && question.options.length > 0
			|| !verbatim && question.options.length > limits.MAX_OPTIONS
		) invalid();
		questions.set(id, {
			multiple: question.multiple as boolean,
			verbatim,
			...(question.response === "text" ? { response: "text" } : {}),
		});
		for (let candidate of question.options) {
			let option = object(candidate);
			let optionId = text(option.id);
			if (ids.has(optionId)) invalid();
			ids.set(optionId, id);
		}
	}
	return { questions, options: ids };
}

export function choices(value: unknown, known: Known): string[] {
	if (!Array.isArray(value)) invalid();
	let found = new Set<string>();
	let counts = new Map<string, number>();
	for (let id of value) {
		if (typeof id !== "string" || !known.options.has(id) || found.has(id)) invalid();
		found.add(id);
		let question = known.options.get(id)!;
		if (known.questions.get(question)!.response === "text") invalid();
		let count = (counts.get(question) ?? 0) + 1;
		if (count > (known.questions.get(question)!.multiple ? limits.MAX_OPTIONS : 1)) invalid();
		counts.set(question, count);
	}
	return value as string[];
}

export function answers(value: unknown, known: Known): { [question: string]: string } {
	let entries = object(value);
	for (let [id, answer] of Object.entries(entries)) {
		let question = known.questions.get(id);
		if (!question) invalid();
		if (question!.verbatim) {
			if (typeof answer !== "string") invalid();
		} else text(answer, limits.MAX_CUSTOM);
	}
	return value as { [question: string]: string };
}

export function editors(value: unknown): string[] {
	if (!Array.isArray(value)) invalid();
	let found = new Set<string>();
	for (let item of value) {
		let handle = text(item);
		if (found.has(handle)) invalid();
		found.add(handle);
	}
	return value as string[];
}

export function history(value: unknown, known: Known): DecisionEntry[] {
	if (!Array.isArray(value)) invalid();
	for (let candidate of value) {
		let entry = object(candidate);
		if (
			Object.keys(entry).some(key => !["choices", "answers", "owner", "at"].includes(key))
			|| !Object.hasOwn(entry, "choices")
			|| !Object.hasOwn(entry, "owner") || !Object.hasOwn(entry, "at")
		) invalid();
		let selected = choices(entry.choices, known);
		let legacy = Object.hasOwn(entry, "answers") ? answers(entry.answers, known) : {};
		let chosenQuestions = new Set(selected.map(id => known.options.get(id)!));
		for (let id of Object.keys(legacy)) {
			if (chosenQuestions.has(id)) invalid();
			chosenQuestions.add(id);
		}
		if (chosenQuestions.size !== known.questions.size) invalid();
		text(entry.owner);
		unix(entry.at);
	}
	return value as DecisionEntry[];
}

export function optionOrigins(
	value: unknown,
	known: Set<string>,
	conversationThread: boolean,
): Record["optionOrigins"] {
	let origins = object(value);
	for (let [id, candidate] of Object.entries(origins)) {
		if (!known.has(id)) invalid();
		let entry = object(candidate);
		if (
			!ORIGINS.has(entry.origin as string)
			|| Object.keys(entry).some(key =>
				key !== "origin" && key !== "rationale" && key !== "by" && key !== "source"
			)
		) {
			invalid();
		}
		if (Object.hasOwn(entry, "rationale")) text(entry.rationale);
		if (Object.hasOwn(entry, "by")) text(entry.by);
		if (Object.hasOwn(entry, "source")) {
			if (entry.origin !== "planner" && entry.origin !== "chat") invalid();
			try {
				assertSourceShape(entry.source);
				let role = (entry.source as ConversationPlan.SourceRef).role;
				if (
					role !== "option" && !(role === "question" && conversationThread
						&& entry.origin === "planner")
				) {
					invalid();
				}
			} catch {
				invalid();
			}
		}
	}
	return value as Record["optionOrigins"];
}

export function prose(value: unknown): Wired.Anchor[] {
	if (!Array.isArray(value)) invalid();
	for (let candidate of value) {
		let anchor = object(candidate);
		if (
			Object.keys(anchor).some(key =>
				key !== "epoch" && key !== "position" && key !== "digest" && key !== "orphaned"
				&& key !== "recoverOnNextEdit"
			)
		) invalid();
		text(anchor.epoch);
		if (
			typeof anchor.position !== "string" || !anchor.position
			|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				anchor.position,
			)
		) {
			invalid();
		}
		if (typeof anchor.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(anchor.digest)) {
			invalid();
		}
		if (Object.hasOwn(anchor, "orphaned") && anchor.orphaned !== true) invalid();
		if (Object.hasOwn(anchor, "recoverOnNextEdit")) {
			if (anchor.recoverOnNextEdit !== true || anchor.orphaned !== true) invalid();
		}
	}
	return value as Wired.Anchor[];
}

export const MAX_FINDINGS = 20;
export const MAX_FINDING_SOURCES = 20;
export const MAX_FINDING_FOCUS = 500;
export const MAX_FINDING_TITLE = 300;
export const MAX_FINDING_SUMMARY = 4_000;
const FINDING_KEYS = new Set([
	"id",
	"kind",
	"status",
	"focus",
	"ref",
	"title",
	"summary",
	"sources",
	"sourceCount",
	"verdict",
	"stance",
	"branch",
	"childId",
	"by",
	"at",
]);

export function findings(value: unknown): Question.Finding[] {
	if (!Array.isArray(value) || value.length > MAX_FINDINGS) invalid();
	let ids = new Set<string>();
	for (let candidate of value) {
		let finding = object(candidate);
		if (Object.keys(finding).some(key => !FINDING_KEYS.has(key))) invalid();
		let id = text(finding.id, 128);
		if (ids.has(id)) invalid();
		ids.add(id);
		if (finding.kind !== "research" && finding.kind !== "spike" && finding.kind !== "ask") {
			invalid();
		}
		if (
			finding.status !== "running" && finding.status !== "ready" && finding.status !== "failed"
			&& finding.status !== "stopped"
		) invalid();
		text(finding.ref, 256);
		text(finding.by);
		unix(finding.at);
		if (Object.hasOwn(finding, "focus")) text(finding.focus, MAX_FINDING_FOCUS);
		if (Object.hasOwn(finding, "title")) text(finding.title, MAX_FINDING_TITLE);
		if (Object.hasOwn(finding, "summary")) text(finding.summary, MAX_FINDING_SUMMARY);
		if (Object.hasOwn(finding, "stance")) {
			if (
				finding.kind !== "ask" || (finding.stance !== "supports" && finding.stance !== "objects")
			) {
				invalid();
			}
		}
		if (Object.hasOwn(finding, "verdict")) text(finding.verdict, MAX_FINDING_TITLE);
		if (Object.hasOwn(finding, "branch")) text(finding.branch, 256);
		if (Object.hasOwn(finding, "childId")) text(finding.childId, 128);
		if (
			Object.hasOwn(finding, "sourceCount")
			&& (!Number.isSafeInteger(finding.sourceCount) || (finding.sourceCount as number) < 0)
		) invalid();
		if (Object.hasOwn(finding, "sources")) {
			if (!Array.isArray(finding.sources) || finding.sources.length > MAX_FINDING_SOURCES) {
				invalid();
			}
			for (let source of finding.sources) {
				let item = object(source);
				if (Object.keys(item).some(key => key !== "title" && key !== "url")) invalid();
				text(item.title, MAX_FINDING_TITLE);
				let url = text(item.url, 2048);
				if (!/^https?:\/\//.test(url)) invalid();
			}
		}
	}
	return value as Question.Finding[];
}
