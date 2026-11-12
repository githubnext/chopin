import { describe, expect, test } from "bun:test";

import { addressed, instruction } from "@chopin/protocol/address";

import { asksChopin, asksChopinKey, draftPlaceholder, withChopinMention } from "./ask-chopin";
import { prepareDraftSubmission } from "./references";

import type { ReferenceDraft } from "./references";

const COMMAND: ReferenceDraft = {
	kind: "command",
	name: "plan",
	commandKind: "skill",
	start: 0,
	end: 5,
	token: "/plan",
};

const DOCUMENT: ReferenceDraft = {
	kind: "document",
	channelId: "c",
	start: 4,
	end: 11,
	token: "#Export",
};

describe("the sparkle button and Command+J put @chopin in the draft", () => {
	test("an empty draft becomes the mention and a space, with the caret after them", () => {
		expect(withChopinMention("", [])).toEqual({ text: "@chopin ", references: [], caret: 8 });
		expect(withChopinMention("", [], 0)).toEqual({ text: "@chopin ", references: [], caret: 8 });
	});

	test("without a caret in the field it goes at the start, before the words", () => {
		expect(withChopinMention("outline the export", [])).toEqual({
			text: "@chopin outline the export",
			references: [],
			caret: 8,
		});
	});

	test("with a caret it goes there, set apart by a space on each side", () => {
		let text = "outline the export";
		// After "outline", before its space: the space that is there is the one after the mention.
		expect(withChopinMention(text, [], 7)).toEqual({
			text: "outline @chopin the export",
			references: [],
			caret: "outline @chopin ".length,
		});
		// After a space, so none is added before it.
		expect(withChopinMention(text, [], 8)).toEqual({
			text: "outline @chopin the export",
			references: [],
			caret: "outline @chopin ".length,
		});
		// At the end.
		expect(withChopinMention(text, [], text.length)).toEqual({
			text: "outline the export @chopin ",
			references: [],
			caret: "outline the export @chopin ".length,
		});
	});

	test("the references after it move with their words, and a caret inside one goes after it", () => {
		let text = "see #Export soon";
		let before = withChopinMention(text, [DOCUMENT], 0);
		expect(before.text).toBe("@chopin see #Export soon");
		expect(before.references).toEqual([{ ...DOCUMENT, start: 12, end: 19 }]);
		let inside = withChopinMention(text, [DOCUMENT], 7);
		expect(inside.text).toBe("see #Export @chopin soon");
		expect(inside.references).toEqual([DOCUMENT]);
		expect(inside.caret).toBe("see #Export @chopin ".length);
	});

	test("a draft that already mentions chopin gets no second mention, only the caret after it", () => {
		for (let text of ["@chopin outline it", "could @Chopin look?", "ask @CHOPIN"]) {
			let next = withChopinMention(text, [], 2);
			expect(next.text).toBe(text);
			let end = text.toLowerCase().indexOf("@chopin") + "@chopin".length;
			expect(next.caret).toBe(text[end] === " " ? end + 1 : end);
		}
		// A command already asks Chopin: nothing is added, and the caret goes to the end.
		expect(withChopinMention("/plan go", [COMMAND], 0)).toEqual({
			text: "/plan go",
			references: [COMMAND],
			caret: 8,
		});
	});

	test("what it writes is a mention the server reads as asking chopin, as a typed one is", () => {
		for (let at of [undefined, 0, 7, 18]) {
			let { text, references } = withChopinMention("outline the export", [], at);
			expect(addressed(text)).toBe(true);
			let sent = prepareDraftSubmission({ text, references }, () => "id")!.submission;
			expect(sent.to).toBe("planner");
			expect(instruction(sent.text)).toBe(instruction(text));
		}
	});

	test("only Command+J or Control+J, without Shift or Option, and never while composing", () => {
		expect(asksChopinKey({ key: "j", metaKey: true })).toBe(true);
		expect(asksChopinKey({ key: "J", ctrlKey: true })).toBe(true);
		expect(asksChopinKey({ key: "j" })).toBe(false);
		expect(asksChopinKey({ key: "j", metaKey: true, shiftKey: true })).toBe(false);
		expect(asksChopinKey({ key: "j", ctrlKey: true, altKey: true })).toBe(false);
		expect(asksChopinKey({ key: "j", metaKey: true, isComposing: true })).toBe(false);
		expect(asksChopinKey({ key: "Process", keyCode: 229, metaKey: true })).toBe(false);
		expect(asksChopinKey({ key: "Backspace" })).toBe(false);
	});
});

describe("who a message is for follows its words", () => {
	test("a mention, typed or put there by the button, asks chopin, in any case and anywhere", () => {
		let put = withChopinMention("what breaks?", []).text;
		for (let text of [put, "@chopin what breaks?", "@Chopin what breaks?", "so, @chopin?"]) {
			expect(asksChopin({ agent: true, text, references: [] })).toBe(true);
			expect(prepareDraftSubmission({ text, references: [] }, () => "id")!.submission.to)
				.toBe("planner");
		}
		expect(asksChopin({ agent: true, text: "what breaks?", references: [] })).toBe(false);
		// An address or a longer word is not a mention.
		expect(asksChopin({ agent: true, text: "mail hi@chopin.dev", references: [] })).toBe(false);
		expect(asksChopin({ agent: true, text: "@chopina", references: [] })).toBe(false);
	});

	test("a reference's own words are never an address, and a command is an address of its own", () => {
		let reference = { ...DOCUMENT, end: 12, token: "#@chopin" };
		expect(asksChopin({ agent: true, text: "see #@chopin", references: [reference] })).toBe(false);
		expect(asksChopin({ agent: true, text: "/plan go", references: [COMMAND] })).toBe(true);
	});

	test("a message the chip sent, which went as @chopin and its words, is chopin's", () => {
		// The chip put `@chopin ` in front of the words on the wire; such messages are stored that way.
		let stored = "@chopin outline the export";
		expect(addressed(stored)).toBe(true);
		expect(asksChopin({ agent: true, text: stored, references: [] })).toBe(true);
		expect(instruction(stored)).toBe("outline the export");
	});

	test("a send already prepared for chopin stays chopin's while it is held", () => {
		expect(asksChopin({ agent: true, text: "what breaks?", references: [], submitted: "planner" }))
			.toBe(true);
	});

	test("a document without an agent has nobody to ask", () => {
		expect(asksChopin({ agent: false, text: "@chopin what breaks?", references: [] })).toBe(false);
		expect(draftPlaceholder(false)).toBe("Message the team");
		expect(draftPlaceholder(true)).toBe("Message the team, or @chopin to ask");
	});
});
