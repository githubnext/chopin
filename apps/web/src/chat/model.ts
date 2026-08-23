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
	| { kind: "system"; id: string; text: string };

export type ToolSummary =
	| { state: "running"; name: string; completed: number }
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
			result.push({ kind: "system", id: row.id, text: row.text });
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

export function summarize(tools: Chat.Activity[]): ToolSummary {
	let running = tools.findLast(tool => tool.status === "running");
	if (running) {
		return {
			state: "running",
			name: toolCopy(running.name),
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
