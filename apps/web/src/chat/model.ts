import { displayName as capitalize } from "@chopin/editor";
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
	workDisconnected?: boolean;
	workStreaming?: boolean;
	workResponseSeen?: boolean;
};

export type Group =
	| { kind: "messages"; author: Speaker; messages: Message[]; queued: boolean }
	| { kind: "system"; id: string; text: string; ts?: number; decision?: Chat.Entry["decision"] };

export type CompletedWork = {
	turnId: string;
	entryOffset: number;
	endOffset: number;
	anchorId: string;
};

export type ToolSummary = {
	count: number;
	finished: number;
	failures: number;
	interrupted: number;
	toolTime: number;
};

export type WorkPhase =
	| "Getting oriented"
	| "Gathering context"
	| "Waiting for an answer"
	| "Making changes"
	| "Working through the request"
	| "Writing a response"
	| "Reviewing the next step";

export function workAnnouncement(phase: WorkPhase): string {
	switch (phase) {
		case "Getting oriented":
			return "Chopin has started.";
		case "Gathering context":
			return "Chopin is gathering context.";
		case "Waiting for an answer":
			return "Chopin needs an answer.";
		case "Making changes":
			return "Chopin is making changes.";
		case "Working through the request":
			return "Chopin is working on the request.";
		case "Writing a response":
			return "Chopin is writing a reply.";
		case "Reviewing the next step":
			return "Chopin is preparing to continue.";
	}
}

function speaker(author: Speaker): string {
	return author.kind === "agent" ? "agent" : `member:${author.handle}`;
}

export { capitalize };

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
	working?: Pick<Chat.Turn, "id" | "started" | "entryOffset">,
	completed: CompletedWork[] = [],
	suspended?: CompletedWork,
): Group[] {
	let replacements = new Map<number, Message>();
	let hiddenTools = new Set<number>();
	let activeIndex = -1;
	let spans = [
		...completed.map(item => ({
			entryOffset: item.entryOffset,
			endOffset: item.endOffset,
			anchorId: item.anchorId,
			active: false,
			disconnected: false,
		})),
		...(suspended
			? [{
				entryOffset: suspended.entryOffset,
				endOffset: suspended.endOffset,
				anchorId: suspended.anchorId,
				active: false,
				disconnected: true,
			}]
			: []),
		...(working
			? [{
				entryOffset: working.entryOffset,
				endOffset: entries.length,
				anchorId: "",
				active: true,
				disconnected: false,
			}]
			: []),
	];
	for (let span of spans) {
		let current = entries.slice(span.entryOffset, span.endOffset)
			.map((entry, index) => ({ entry, index: index + span.entryOffset }))
			.filter(({ entry }) => entry.author.kind === "agent");
		let anchor = span.anchorId
			? current.find(({ entry }) => entry.id === span.anchorId)
			: current.find(({ entry }) =>
				!!entry.tools?.length || !!entry.text.trim() || !!entry.streaming
			);
		if (!anchor) continue;
		let tools = current.flatMap(({ entry }) => entry.tools ?? []);
		if (!span.active && !span.disconnected && !tools.length) continue;
		if (span.active) activeIndex = anchor.index;
		replacements.set(anchor.index, {
			...anchor.entry,
			author: { kind: "agent" },
			tools,
			queued: false,
			...(span.disconnected ? { workDisconnected: true } : {}),
			...(span.active
				? {
					working: true,
					workStreaming: current.some(({ entry }) => !!entry.streaming),
					workResponseSeen: current.some(({ entry }) => !!entry.text.trim()),
				}
				: {}),
		});
		for (let item of current) {
			if (item.index !== anchor.index && item.entry.tools?.length) hiddenTools.add(item.index);
		}
	}
	let rows: Array<Chat.Entry | Message> = [
		...entries.map((entry, index) =>
			replacements.get(index)
				?? (hiddenTools.has(index) && entry.author.kind === "agent" && entry.tools?.length
					? { ...entry, tools: undefined }
					: entry)
		),
		...(working && activeIndex < 0
			? [{
				id: working.id,
				author: { kind: "agent" as const },
				text: "",
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

export function workPhase(
	tools: Chat.Activity[],
	streaming: boolean,
	active: boolean,
	responseSeen = false,
): WorkPhase | undefined {
	if (!active) return undefined;
	let running = tools.findLast(tool => tool.status === "running");
	if (running) {
		if (running.name === "ask") return "Waiting for an answer";
		if (
			/(^|[_/.-])(read|get|list|search|grep|find|query|fetch|inspect)(?=$|[_/.-])/i.test(
				running.name,
			)
		) return "Gathering context";
		if (
			/(^|[_/.-])(edit|write|create|update|delete|anchor|link|apply|append|move|remove)(?=$|[_/.-])/i
				.test(
					running.name,
				)
		) return "Making changes";
		return "Working through the request";
	}
	if (streaming) return "Writing a response";
	if (tools.length || responseSeen) return "Reviewing the next step";
	return "Getting oriented";
}

export function summarize(tools: Chat.Activity[], active: boolean): ToolSummary {
	return {
		count: tools.length,
		finished: tools.filter(tool => tool.status !== "running").length,
		failures: tools.filter(tool => tool.status === "failed").length,
		interrupted: active ? 0 : tools.filter(tool => tool.status === "running").length,
		toolTime: tools.reduce((total, tool) => total + (tool.took ?? 0), 0),
	};
}

export function duration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	return `${(milliseconds / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
}

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

export function waitingPrompts(tools: Chat.Activity[]): string[] | undefined {
	let running = tools.findLast(tool => tool.status === "running");
	return running?.name === "ask" ? askedPrompts(running.args) : undefined;
}

/**
 * Open decision cards a waiting `ask` call is blocked on. A card matches when any of
 * its questions asks one of the call's prompts; the count is of distinct cards, or of
 * distinct prompts while no card has arrived yet.
 */
export function waitingCards(
	prompts: string[],
	cards: Array<{ id: string; prompts: string[]; open: boolean }>,
): { ids: string[]; count: number } {
	let asked = new Set(prompts.map(prompt => prompt.trim()).filter(Boolean));
	let ids = [
		...new Set(
			cards
				.filter(card => card.open && card.prompts.some(prompt => asked.has(prompt.trim())))
				.map(card => card.id),
		),
	];
	return { ids, count: ids.length || asked.size };
}

export function waitingText(count: number): string {
	return count > 1 ? `Waiting on ${count} decisions` : "Waiting on your decision";
}
