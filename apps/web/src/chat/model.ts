import { instruction } from "@chopin/protocol/address";

import type { Chat } from "@chopin/protocol";

type Speaker = Exclude<Chat.Author, { kind: "system" }>;

export type Message = {
	id: string;
	author: Speaker;
	text: string;
	ts?: number;
	streaming?: boolean;
	tools?: Chat.Activity[];
	references?: Chat.Reference[];
	queued: boolean;
	working?: boolean;
};

export type Group =
	| { kind: "messages"; author: Speaker; messages: Message[]; queued: boolean }
	| { kind: "system"; id: string; text: string; ts?: number; decision?: Chat.Entry["decision"] };

export type ToolSummary =
	| { state: "running"; label: string; completed: number }
	| { state: "waiting"; prompts: string[] }
	| { state: "finished"; count: number; failures: number; elapsed: number };

function speaker(author: Speaker): string {
	return author.kind === "agent" ? "agent" : `member:${author.handle}`;
}

export function capitalize(value: string): string {
	return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** Tool names are protocol identifiers; the transcript is for people. */
export function toolCopy(name: string): string {
	if (name === "ask") return "Questions";
	return capitalize(name.replaceAll(/[_/]/g, " "));
}

/** Mentions remain useful input syntax, but are not part of rail typography. */
export function displayText(value: string): string {
	return instruction(value).replace(
		/(^|[^\w@])@([a-z0-9][a-z0-9-]*)\b/gi,
		(_match, before: string, handle: string) => `${before}${capitalize(handle)}`,
	);
}

export function group(
	entries: Chat.Entry[],
	queued: Chat.Waiting[],
	working?: Pick<Chat.Turn, "id" | "started">,
): Group[] {
	let rows: Array<Chat.Entry | Message> = [
		...entries,
		...(working
			? [{
				id: working.id,
				author: { kind: "agent" as const },
				text: "Working on it",
				ts: working.started,
				queued: false,
				working: true,
			}]
			: []),
		...queued.map(item => ({
			id: item.id,
			author: { kind: "member" as const, handle: item.handle },
			text: item.text,
			references: item.references,
			queued: true,
		})),
	];
	let result: Group[] = [];

	for (let row of rows) {
		if ("queued" in row) {
			append(result, row);
			continue;
		}
		if (row.author.kind === "system") {
			result.push({
				kind: "system",
				id: row.id,
				text: row.text,
				ts: row.ts,
				decision: row.decision,
			});
			continue;
		}
		append(result, { ...row, author: row.author, queued: false });
	}
	return result;
}

function append(result: Group[], message: Message): void {
	let previous = result.at(-1);
	if (
		previous?.kind === "messages"
		&& previous.queued === message.queued
		&& speaker(previous.author) === speaker(message.author)
	) {
		previous.messages.push(message);
		return;
	}
	result.push({
		kind: "messages",
		author: message.author,
		messages: [message],
		queued: message.queued,
	});
}

const RUNNING_LABELS: { [name: string]: string } = {
	read_plan: "Reading the document",
	edit_plan: "Editing the document",
	anchor_plan: "Linking decisions to prose",
	read_reference: "Reading a reference",
	read_repository_file: "Reading a file",
	list_repository_tree: "Browsing the repository",
	search_repository: "Searching the repository",
	repository_history: "Reading repository history",
	list_pull_requests: "Listing pull requests",
	pull_request_read: "Reading a pull request",
	list_background_jobs: "Checking background work",
	read_background_job: "Reading background work",
	create_research_workspace: "Starting research",
	read_implementation_graph: "Reading tasks",
	edit_implementation_graph: "Editing tasks",
	revise_open_decision: "Revising a decision",
};

/** What a running tool is doing, in sentence case. */
export function runningLabel(name: string): string {
	return RUNNING_LABELS[name] ?? toolCopy(name);
}

/** The question prompts an `ask` call carries, so its live cards can be found. */
function askedPrompts(args: string | undefined): string[] {
	try {
		let parsed: unknown = JSON.parse(args ?? "");
		let questions = (parsed as { questions?: unknown }).questions;
		if (!Array.isArray(questions)) return [];
		return questions.flatMap(item => {
			let prompt = (item as { question?: unknown } | null)?.question;
			return typeof prompt === "string" ? [prompt] : [];
		});
	} catch {
		return [];
	}
}

export function summarize(tools: Chat.Activity[]): ToolSummary {
	let running = tools.findLast(tool => tool.status === "running");
	// `ask` stays running until people answer; it is waiting, not working.
	if (running?.name === "ask") return { state: "waiting", prompts: askedPrompts(running.args) };
	if (running) {
		return {
			state: "running",
			label: runningLabel(running.name),
			completed: tools.filter(tool => tool.status !== "running").length,
		};
	}
	return {
		state: "finished",
		count: tools.length,
		failures: tools.filter(tool => tool.status === "failed").length,
		elapsed: tools.reduce((total, tool) => total + (tool.took ?? 0), 0),
	};
}

export function duration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	return `${(milliseconds / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
}

/** Open decision cards a waiting `ask` call is blocked on, matched by prompt. */
export function waitingCards(
	prompts: string[],
	cards: Array<{ id: string; prompt?: string; open: boolean }>,
): string[] {
	let ids: string[] = [];
	for (let prompt of prompts) {
		let card = cards.findLast(item =>
			item.open && item.prompt === prompt && !ids.includes(item.id)
		);
		if (card) ids.push(card.id);
	}
	return ids;
}

export function waitingText(count: number): string {
	return count > 1 ? `Waiting on ${count} decisions` : "Waiting on your decision";
}
