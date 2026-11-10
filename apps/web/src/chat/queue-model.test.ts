import { describe, expect, it } from "bun:test";

import {
	editedText,
	focusAfterRemoval,
	queueCaption,
	queueRows,
	refusalWords,
} from "./queue-model";
import { group } from "./model";

import type { Chat } from "@chopin/protocol";

const waiting = (id: string, handle: string, text: string, kind?: Chat.Waiting["kind"]) =>
	({
		id,
		handle,
		text,
		...(kind ? { kind } : {}),
	}) satisfies Chat.Waiting;

describe("the rows of the queue", () => {
	it("lists what waits in the order the server gave, with who asked and what", () => {
		let rows = queueRows(
			[
				waiting("a", "ana", "Compare the options."),
				waiting("b", "felix", "Tighten the intro."),
				waiting("c", "ana", "Reply to a comment", "comment"),
				waiting("d", "chopin", "Re-checking decisions against the document", "job"),
			],
			[],
			"ana",
		);
		expect(rows.map(row => [row.id, row.name, row.message, row.mine])).toEqual([
			["a", "Ana", true, true],
			["b", "Felix", true, false],
			["c", "Ana", false, false],
			["d", "Chopin", false, false],
		]);
		// Chopin's own work has no face to draw; a person's has.
		expect(rows[3]!.handle).toBeUndefined();
		expect(rows[0]!.handle).toBe("ana");
		expect(rows.map(row => row.text)).toEqual([
			"Compare the options.",
			"Tighten the intro.",
			"Reply to a comment",
			"Re-checking decisions against the document",
		]);
	});

	it("lets only a person's own typed message be changed by them", () => {
		let rows = queueRows(
			[
				waiting("a", "ana", "mine"),
				waiting("b", "ana", "Reply to a comment", "comment"),
				waiting("c", "ana", "Draft of the build tasks", "draft"),
				waiting("d", "ana", "Automatic follow-up", "followup"),
				waiting("e", "felix", "theirs"),
			],
			[],
			"ana",
		);
		expect(rows.filter(row => row.mine).map(row => row.id)).toEqual(["a"]);
	});

	it("keeps an MCP message with no delivery mark in the queue while it waits", () => {
		let queue = [waiting("mcp", "ana", "Compare the options")];
		let entries: Pick<Chat.Entry, "id" | "deliveryState">[] = [{ id: "mcp" }];
		expect(queueRows(queue, entries, "ana").map(row => row.id)).toEqual(["mcp"]);
	});

	it("drops a turn whose message is already delivered or failed: it has started or ended", () => {
		let queue = [
			waiting("a", "ana", "one"),
			waiting("b", "ana", "two"),
			waiting("c", "ana", "three"),
		];
		let entries: Pick<Chat.Entry, "id" | "deliveryState">[] = [
			{ id: "a", deliveryState: "delivered" },
			{ id: "b", deliveryState: "sent" },
			{ id: "c", deliveryState: "failed" },
		];
		expect(queueRows(queue, entries, "ana").map(row => [row.id, row.sent])).toEqual([["b", true]]);
		expect(queueRows(queue, [], "ana").map(row => row.id)).toEqual(["a", "b", "c"]);
	});
});

it("keeps work nobody typed while the entry it waits under, such as a comment's notice, is in the transcript", () => {
	let queue = [waiting("notice", "ana", "Reply to a comment", "comment")];
	let entries: Pick<Chat.Entry, "id" | "deliveryState">[] = [{ id: "notice" }];
	expect(queueRows(queue, entries, "ana").map(row => row.id)).toEqual(["notice"]);
});

describe("the transcript beside the queue", () => {
	it("leaves a message out while it waits, and puts it back once it has started", () => {
		let author = { kind: "member" as const, handle: "ana" };
		let entries: Chat.Entry[] = [
			{ id: "earlier", author, text: "earlier", ts: 1, deliveryState: "delivered" },
			{ id: "plain", author, text: "plain", ts: 1 },
			{ id: "waits", author, text: "waits", ts: 1, deliveryState: "sent" },
			{ id: "failed", author, text: "failed", ts: 1, deliveryState: "failed" },
		];
		let ids = (queue: string[]) =>
			group(entries, undefined, [], undefined, new Set(queue))
				.flatMap(item => item.kind === "messages" ? item.messages.map(message => message.id) : []);
		// Only a message that is sent and waiting leaves; the rest are the transcript's own.
		expect(ids(["waits", "earlier"])).toEqual(["earlier", "plain", "failed"]);
		expect(ids([])).toEqual(["earlier", "plain", "waits", "failed"]);
		expect(ids(["elsewhere"])).toEqual(["earlier", "plain", "waits", "failed"]);
		expect(ids(["plain"])).toEqual(["earlier", "waits", "failed"]);
	});
});

describe("the queue's count and focus", () => {
	let rows = Array.from({ length: 5 }, (_, index) => ({
		id: String(index),
		name: "Ana",
		text: String(index),
		message: true,
		mine: true,
	}));

	it("says how many are waiting, in plain words", () => {
		expect(queueCaption(1)).toBe("1 waiting for Chopin");
		expect(queueCaption(12)).toBe("12 waiting for Chopin");
	});

	it("moves focus to the row that took a cancelled one's place, else the one before, else nowhere", () => {
		expect(focusAfterRemoval(rows, "1")).toBe("2");
		expect(focusAfterRemoval(rows, "4")).toBe("3");
		expect(focusAfterRemoval(rows.slice(0, 1), "0")).toBeUndefined();
		expect(focusAfterRemoval(rows, "gone")).toBeUndefined();
		let mixed = [rows[0]!, { ...rows[1]!, mine: false }, rows[2]!];
		expect(focusAfterRemoval(mixed, "0")).toBe("2");
		expect(focusAfterRemoval(mixed.slice(0, 2), "0")).toBeUndefined();
		expect(focusAfterRemoval(mixed, "2")).toBe("0");
	});
});

describe("what a refused change is told in", () => {
	it("says plainly that the turn already started, for the one refusal that has a code", () => {
		for (let change of ["cancel", "edit"] as const) {
			let words = refusalWords(change, {
				code: "already-started",
				message: "its turn has already started",
			});
			expect(words).toBe("Chopin already started on it, so it can't be changed.");
		}
	});

	it("names what the server refused when it can be said in a line, and otherwise that it can be tried again", () => {
		expect(refusalWords("edit", { message: "message text is empty" })).toBe(
			"A message can't be empty.",
		);
		expect(refusalWords("edit", { message: "chat message exceeds the 64 KiB limit" })).toBe(
			"That message is too long to send.",
		);
		expect(refusalWords("edit", { message: "only the author of a queued message can change it" }))
			.toBe("Only the person who wrote it can change it.");
		expect(refusalWords("edit", { message: "invalid or unavailable chat reference" })).toContain(
			"link",
		);
		expect(refusalWords("cancel", new Error("storage unavailable"))).toBe(
			"Couldn't cancel it. Try again.",
		);
		expect(refusalWords("edit", undefined as never)).toBe("Couldn't save the change. Try again.");
		expect(
			refusalWords("edit", {
				code: "temporarily-unavailable",
				message: "it is about to start; try again in a moment",
			}),
		)
			.toBe("Couldn't save the change. Try again.");
	});
});

describe("saving an edit", () => {
	it("saves what was typed, trimmed, only when it says something new", () => {
		expect(editedText("Compare the options.", "  Compare the two options. ")).toBe(
			"Compare the two options.",
		);
		expect(editedText("Compare the options.", "Compare the options.")).toBeUndefined();
		expect(editedText("Compare the options. ", " Compare the options.")).toBeUndefined();
		expect(editedText("Compare the options.", "   ")).toBeUndefined();
		expect(editedText("Compare the options.", "")).toBeUndefined();
	});
});
