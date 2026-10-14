import { createHash } from "node:crypto";

import type { Chat } from "@chopin/protocol";
import type { RecommendationEvidence } from "@chopin/protocol/recommendation";
import type { Investigation } from "@chopin/experiment/records";
import type { Record as Decision } from "../questions/record-types";
import type { Record as Comment } from "../comments/service";
import type { JsonValue } from "../storage/model";
import type { RecommendationInput } from "./schema";

export type RecommendationDocument = { source: string; sidecar: JsonValue };
export type RecommendationResearch = {
	id: string;
	title: string;
	source: string;
	revision: number;
};

const REPOSITORY_READS = new Set([
	"read_repository_file",
	"list_repository_tree",
	"search_repository",
	"repository_history",
	"get_file_contents",
	"get_file_content",
	"read_file",
	"get_repository_tree",
	"list_commits",
	"get_commit",
	"search_code",
	"get_pull_request",
	"pull_request_read",
]);

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function excerpt(value: string, limit: number): string {
	if (textBytes(value) <= limit) return value;
	let marker = "\n[Excerpt; remaining text omitted.]";
	if (textBytes(marker) > limit) marker = "[...]";
	if (textBytes(marker) > limit) return "";
	let prefix = (end: number) => {
		if (
			end > 0 && end < value.length
			&& value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
			&& value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff
		) end--;
		return value.slice(0, end);
	};
	let low = 0;
	let high = value.length;
	let available = limit - textBytes(marker);
	while (low < high) {
		let middle = Math.ceil((low + high) / 2);
		if (textBytes(prefix(middle)) <= available) low = middle;
		else high = middle - 1;
	}
	return `${prefix(low)}${marker}`;
}

function textBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value)) - 2;
}

/** Only committed records enter an assessment; draft answers and streamed text are excluded. */
export function recommendationContext(
	document: RecommendationDocument,
	investigations: Investigation[] = [],
	research: RecommendationResearch[] = [],
): RecommendationInput | undefined {
	let sidecar = document.sidecar as {
		revision?: number;
		questions?: Decision[];
		threads?: Comment[];
		transcript?: Chat.Entry[];
	};
	let planRevision = sidecar.revision;
	if (!Number.isSafeInteger(planRevision) || planRevision! < 0) return;
	let discussion = (sidecar.transcript ?? []).filter(entry =>
		entry.author.kind === "member" && entry.text.trim()
	).slice(-12).map(entry => ({ id: entry.id, author: entry.author, text: entry.text }));
	if (!document.source.trim().replace(/^# [^\n]*$/, "") && !discussion.length) return;
	let decisions = (sidecar.questions ?? []).map(record => ({
		id: record.id,
		status: record.status,
		definition: record.definition,
		choices: record.choices,
		answers: record.answers,
		decidedAt: record.decidedAt,
		history: record.history,
	}));
	let comments = (sidecar.threads ?? []).filter(thread =>
		thread.status === "open"
		|| thread.status === "accepted"
	).map(thread => ({
		id: thread.id,
		status: thread.status,
		quote: thread.quote,
		notes: thread.notes,
	}));
	let repository = (sidecar.transcript ?? []).flatMap(entry =>
		(entry.tools ?? []).filter(tool =>
			tool.status === "done" && !!tool.result
			&& REPOSITORY_READS.has(tool.name.replace(/^github_/, ""))
		).map(tool => ({
			id: tool.id,
			name: tool.name,
			args: tool.args,
			result: tool.result!,
		}))
	).slice(-6);
	let observed = investigations.filter(value => !value.spike?.dismissed).map(value => ({
		id: value.id,
		revision: value.revision,
		state: value.state,
		brief: value.brief,
		buildBlocker: value.buildBlocker,
		report: value.state === "completed" ? value.result?.report : undefined,
		decisions: value.decisions,
	}));
	let evidence: RecommendationEvidence[] = [];
	let bytes = 0;
	let add = (value: RecommendationEvidence, budget: number) => {
		value.detail = value.detail.trim();
		let size = Buffer.byteLength(JSON.stringify(value));
		if (size > budget || evidence.length >= 48 || bytes + size > 110_000) {
			throw new Error("Recommendation evidence exceeds its reserved budget.");
		}
		evidence.push(value);
		bytes += size;
	};
	let source = document.source;
	let documentCount = Math.ceil(Math.min(source.length, 22_000) / 5500);
	let start = 0;
	for (let index = 0; index < documentCount; index++) {
		let end = Math.min(source.length, (index + 1) * 5500);
		if (
			end < source.length
			&& source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff
			&& source.charCodeAt(end) >= 0xdc00 && source.charCodeAt(end) <= 0xdfff
		) end--;
		let value: RecommendationEvidence = {
			id: `document:${index + 1}`,
			kind: "document",
			label: start ? "Document continued" : "Current document",
			detail: "",
		};
		let budget = Math.floor(16_000 / documentCount);
		let available = Math.min(6000, budget - Buffer.byteLength(JSON.stringify(value)));
		let prefix = "Authored intent, not verified implementation.\n";
		let omitted = index === 3 && end < source.length ? "\n[Remaining document omitted.]" : "";
		value.detail = `${prefix}${
			excerpt(source.slice(start, end), available - textBytes(prefix) - textBytes(omitted))
		}${omitted}`;
		add(value, budget);
		start = end;
	}
	for (let entry of discussion) {
		let value: RecommendationEvidence = {
			id: `discussion:${entry.id}`,
			kind: "discussion",
			label: excerpt(`@${entry.author.kind === "member" ? entry.author.handle : "member"}`, 190),
			detail: "",
		};
		let budget = Math.floor(12_000 / discussion.length);
		let available = Math.min(1500, budget - Buffer.byteLength(JSON.stringify(value)));
		value.detail = excerpt(entry.text, available);
		add(value, budget);
	}
	let selectedDecisions = decisions.toSorted((a, b) =>
		Number(b.status === "open" || b.status === "reopened")
		- Number(a.status === "open" || a.status === "reopened")
	).slice(0, 10);
	for (let record of selectedDecisions) {
		let value: RecommendationEvidence = {
			id: `decision:${record.id}`,
			kind: "decision",
			label: excerpt(record.definition.questions[0]?.question ?? "Decision", 190),
			detail: "",
		};
		let budget = Math.floor(24_000 / selectedDecisions.length);
		let available = Math.min(6000, budget - Buffer.byteLength(JSON.stringify(value)));
		let count = Math.max(1, record.definition.questions.length);
		let detail = [JSON.stringify({ status: record.status, decidedAt: record.decidedAt })];
		let omitted = "[Option descriptions and decision history omitted.]";
		let empty = record.definition.questions.map(() =>
			"Question: \nSaved answer: \nSelected options: \nAvailable options: "
		);
		let fields = available - textBytes([...detail, ...empty, omitted].join("\n\n"));
		// Each question and its saved answer keep a share even when definitions are verbose.
		for (let question of record.definition.questions) {
			let selected = question.options.filter(option => record.choices?.includes(option.id))
				.map(option => option.label).join("; ");
			detail.push([
				`Question: ${excerpt(question.question, Math.floor(fields * 1400 / 4400 / count))}`,
				`Saved answer: ${
					excerpt(
						record.answers?.[question.id] ?? "None recorded.",
						Math.floor(fields * 1600 / 4400 / count),
					)
				}`,
				`Selected options: ${
					excerpt(selected || "None recorded.", Math.floor(fields * 800 / 4400 / count))
				}`,
				`Available options: ${
					excerpt(
						question.options.map(option => option.label).join("; "),
						Math.floor(fields * 600 / 4400 / count),
					)
				}`,
			].join("\n"));
		}
		detail.push(omitted);
		value.detail = detail.join("\n\n");
		add(value, budget);
	}
	let selectedComments = comments.slice(-4);
	for (let thread of selectedComments) {
		let value: RecommendationEvidence = {
			id: `comment:${thread.id}`,
			kind: "discussion",
			label: "Document discussion",
			detail: "",
		};
		let budget = Math.floor(5000 / selectedComments.length);
		let available = Math.min(2000, budget - Buffer.byteLength(JSON.stringify(value)));
		let human = thread.notes.filter(note => note.author === "member").slice(-3);
		let authors = human.map(note =>
			JSON.stringify({ author: note.author, handle: note.handle, ts: note.ts, to: note.to })
		);
		let status = JSON.stringify({ status: thread.status });
		let omitted = thread.notes.length > human.length
			? ["[Earlier human notes and Planner replies omitted.]"]
			: [];
		let empty = [
			status,
			"Quote: ",
			`Latest human notes:\n${
				authors.map(author => `${author}\n`).join("\n\n") || "None recorded."
			}`,
			...omitted,
		];
		let fields = available - textBytes(empty.join("\n\n"));
		let quoteBytes = human.length ? Math.floor(fields / 5) : fields;
		let noteBytes = human.length ? Math.floor((fields - quoteBytes) / human.length) : 0;
		let notes = human.map((note, index) => `${authors[index]}\n${excerpt(note.text, noteBytes)}`);
		value.detail = [
			status,
			`Quote: ${excerpt(thread.quote ?? "No frozen quote supplied.", quoteBytes)}`,
			`Latest human notes:\n${notes.join("\n\n") || "None recorded."}`,
			...omitted,
		].join("\n\n");
		add(value, budget);
	}
	for (let tool of repository) {
		let value: RecommendationEvidence = {
			id: `repository:${tool.id}`,
			kind: "repository",
			label: tool.name,
			detail: "",
		};
		let budget = Math.floor(10_000 / repository.length);
		let available = Math.min(4000, budget - Buffer.byteLength(JSON.stringify(value)));
		let prefix = "Previously observed tool output; repository may have changed.\nArguments: ";
		let fields = available - textBytes(`${prefix}\n`);
		value.detail = `${prefix}${excerpt(tool.args ?? "", Math.floor(fields / 5))}\n${
			excerpt(tool.result, Math.floor(fields * 4 / 5))
		}`;
		add(value, budget);
	}
	let selectedInvestigations = observed.toSorted((a, b) =>
		Number(!!b.buildBlocker) - Number(!!a.buildBlocker) || b.revision - a.revision
	).slice(0, 6);
	for (let item of selectedInvestigations) {
		let value: RecommendationEvidence = {
			id: `investigation:${item.id}`,
			kind: "investigation",
			label: excerpt(item.brief, 190),
			detail: "",
		};
		let budget = Math.floor(16_000 / selectedInvestigations.length);
		let available = Math.min(6000, budget - Buffer.byteLength(JSON.stringify(value)));
		let selected = item.decisions.slice(-3);
		let state = JSON.stringify({ state: item.state, revision: item.revision });
		let omitted = item.decisions.length > 3 ? ["[Earlier human evidence decisions omitted.]"] : [];
		let empty = [
			state,
			"Build requirement: ",
			"Findings: ",
			"Brief: ",
			`Human evidence decisions: ${
				selected.map(() => "\nRationale: ").join("\n\n") || "None recorded."
			}`,
			...omitted,
		];
		let fields = available - textBytes(empty.join("\n\n"));
		let weight = 3700 + selected.length * 350;
		let conclusions = selected.map(decision =>
			`${excerpt(decision.conclusion, Math.floor(fields * 200 / weight))}\nRationale: ${
				excerpt(decision.rationale, Math.floor(fields * 150 / weight))
			}`
		);
		value.detail = [
			state,
			`Build requirement: ${
				excerpt(item.buildBlocker ?? "None recorded.", Math.floor(fields * 1000 / weight))
			}`,
			`Findings: ${
				excerpt(item.report ?? "No completed report supplied.", Math.floor(fields * 2200 / weight))
			}`,
			`Brief: ${excerpt(item.brief, Math.floor(fields * 500 / weight))}`,
			`Human evidence decisions: ${conclusions.join("\n\n") || "None recorded."}`,
			...omitted,
		].join("\n\n");
		add(value, budget);
	}
	let selectedResearch = research.slice(-4);
	for (let item of selectedResearch) {
		let value: RecommendationEvidence = {
			id: `research:${item.id}`,
			kind: "research",
			label: excerpt(item.title, 190),
			detail: "",
		};
		let budget = Math.floor(13_000 / selectedResearch.length);
		let available = Math.min(5500, budget - Buffer.byteLength(JSON.stringify(value)));
		value.detail = excerpt(item.source, available);
		add(value, budget);
	}
	return {
		key: digest({
			version: 2,
			planRevision,
			source,
			discussion,
			decisions,
			comments,
			repository,
			investigations: observed,
			research,
		}),
		planRevision: planRevision!,
		evidence,
	};
}
