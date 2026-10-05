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
	workStreaming?: boolean;
	workResponseSeen?: boolean;
};

export type Group =
	| { kind: "messages"; author: Speaker; messages: Message[]; queued: boolean }
	| { kind: "system"; id: string; text: string; ts?: number; decision?: Chat.Entry["decision"] };

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
	let promptIndex = working
		? entries.findLastIndex(entry => entry.author.kind === "member" && entry.ts <= working.started)
		: -1;
	let current = working
		? entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) =>
			index > promptIndex && entry.author.kind === "agent" && entry.ts >= working.started
		)
		: [];
	let activeIndex =
		current.find(({ entry }) => !!entry.tools?.length || !!entry.text.trim() || !!entry.streaming)
			?.index ?? -1;
	let activeTools = current.flatMap(({ entry }) => entry.tools ?? []);
	let currentIndices = new Set(current.map(({ index }) => index));
	let workStreaming = current.some(({ entry }) => !!entry.streaming);
	let workResponseSeen = current.some(({ entry }) => !!entry.text.trim());
	let rows: Array<Chat.Entry | Message> = [
		...entries.map((entry, index) =>
			index === activeIndex && entry.author.kind === "agent"
				? {
					...entry,
					author: { kind: "agent" },
					tools: activeTools,
					queued: false,
					working: true,
					workStreaming,
					workResponseSeen,
				} satisfies Message
				: currentIndices.has(index) && entry.author.kind === "agent" && entry.tools?.length
				? { ...entry, tools: undefined }
				: entry
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
