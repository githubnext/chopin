import { isDeepStrictEqual } from "node:util";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import type { Chat as Wire } from "@chopin/protocol";
import type { Server } from "bun";
import type { SocketData } from "../wire";
import type { Room } from "./service";

export type Announcer = Pick<Room, "chat" | "plan" | "server" | "room">;
export type NoticeInput = string | { text: string; decision?: NonNullable<Wire.Entry["decision"]> };

export function createNotices({ now, announce }: {
	now: () => number;
	announce: (server: Server<SocketData>, room: string, entry: Wire.Entry) => void;
}) {
	function notice(context: Announcer, input: NoticeInput): Promise<Wire.Entry> {
		return Service.exclusive(context.plan, () => noticeExclusive(context, input));
	}

	function noticeOnce(
		context: Announcer,
		id: string,
		input: NoticeInput,
	): Promise<Wire.Entry> {
		if (!id) return Promise.reject(new Error("chat notice ID is required"));
		return Service.exclusive(context.plan, async () => {
			let existing = context.chat.entries.filter(entry => entry.id === id);
			if (existing.length > 0) {
				let entry = existing[0];
				let { text, decision } = typeof input === "string"
					? { text: input, decision: undefined }
					: input;
				if (
					existing.length !== 1
					|| entry.author.kind !== "system"
					|| entry.text !== text
					|| Object.hasOwn(entry, "streaming")
					|| Object.hasOwn(entry, "tools")
					|| Object.hasOwn(entry, "references")
					|| entry.decision?.questionnaireId !== decision?.questionnaireId
					|| entry.decision?.kind !== decision?.kind
					|| entry.decision?.generation !== decision?.generation
					|| entry.decision?.label !== decision?.label
					|| !isDeepStrictEqual(entry.decision, decision)
				) throw new Error(`chat notice ${id} conflicts with an existing entry`);
				return entry;
			}
			return appendNoticeExclusive(context, input, id);
		});
	}

	function noticeExclusive(context: Announcer, input: NoticeInput): Promise<Wire.Entry> {
		return appendNoticeExclusive(context, input, ulid());
	}

	async function refreshNoticeExclusive(
		context: Announcer,
		id: string,
		input: { text: string; decision: NonNullable<Wire.Entry["decision"]> },
	): Promise<Wire.Entry> {
		let matches = context.chat.entries.filter(entry => entry.id === id);
		let previous = matches[0];
		if (
			matches.length !== 1 || !previous || previous.author.kind !== "system"
			|| (previous.decision?.kind !== input.decision.kind
				&& !(previous.decision?.kind === "scoped-choice" && input.decision.kind === "activity")
				&& !(previous.decision?.kind === "prompt" && input.decision.kind === "activity"))
			|| previous.decision.questionnaireId !== input.decision.questionnaireId
			|| Object.hasOwn(previous, "streaming") || Object.hasOwn(previous, "tools")
			|| Object.hasOwn(previous, "references")
		) throw new Error("chat notice cannot be refreshed");
		let index = context.chat.entries.indexOf(previous);
		let entry: Wire.Entry = {
			...previous,
			text: input.text,
			decision: structuredClone(input.decision),
		};
		context.chat.entries[index] = entry;
		try {
			await Service.persistExclusive(context.plan);
		} catch (error) {
			context.chat.entries[index] = previous;
			throw error;
		}
		try {
			announce(context.server, context.room, entry);
		} catch (error) {
			console.error("[chat] could not broadcast a persisted notice refresh:", error);
		}
		return entry;
	}

	async function appendNoticeExclusive(
		context: Announcer,
		input: NoticeInput,
		id: string,
	): Promise<Wire.Entry> {
		let { chat, room, server } = context;
		let { text, decision } = typeof input === "string"
			? { text: input, decision: undefined }
			: input;
		let entry: Wire.Entry = {
			id,
			author: { kind: "system" },
			text,
			ts: now(),
			...(decision ? { decision: { ...decision } } : {}),
		};
		chat.entries.push(entry);
		try {
			await Service.persistExclusive(context.plan);
		} catch (error) {
			chat.entries = chat.entries.filter(value => value !== entry);
			throw error;
		}
		try {
			announce(server, room, entry);
		} catch (error) {
			console.error("[chat] could not broadcast a persisted notice:", error);
		}
		return entry;
	}

	return { notice, noticeOnce, noticeExclusive, refreshNoticeExclusive };
}
