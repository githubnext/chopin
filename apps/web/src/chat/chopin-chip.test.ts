import { describe, expect, test } from "bun:test";

import {
	asksChopin,
	chipKeyAction,
	chipShown,
	draftPlaceholder,
	restoredChip,
	takeChopinMention,
	withoutChopinMentions,
} from "./chopin-chip";

import type { ReferenceDraft } from "./references";

const COMMAND: ReferenceDraft = {
	kind: "command",
	name: "plan",
	commandKind: "skill",
	start: 0,
	end: 5,
	token: "/plan",
};

describe("who a message is for", () => {
	test("the chip alone makes a message Chopin's, whatever the words say", () => {
		expect(asksChopin({ agent: true, chip: true, text: "what breaks?", references: [] })).toBe(
			true,
		);
		expect(asksChopin({ agent: true, chip: false, text: "what breaks?", references: [] })).toBe(
			false,
		);
	});

	test("Chopin named in the words still asks it, as it always has", () => {
		expect(asksChopin({ agent: true, chip: false, text: "can @chopin look?", references: [] }))
			.toBe(true);
		// A reference's own words are never an address.
		let reference = {
			kind: "document" as const,
			channelId: "c",
			start: 4,
			end: 12,
			token: "#@chopin",
		};
		expect(asksChopin({ agent: true, chip: false, text: "see #@chopin", references: [reference] }))
			.toBe(false);
	});

	test("a command is an address of its own", () => {
		expect(asksChopin({ agent: true, chip: false, text: "/plan go", references: [COMMAND] }))
			.toBe(true);
	});

	test("a send already prepared for Chopin stays Chopin's while it is held", () => {
		expect(
			asksChopin({
				agent: true,
				chip: false,
				text: "what breaks?",
				references: [],
				submitted: "planner",
			}),
		).toBe(true);
	});

	test("nothing is for Chopin where there is no agent", () => {
		expect(asksChopin({ agent: false, chip: true, text: "@chopin hi", references: [] })).toBe(
			false,
		);
	});
});

describe("when the chip is shown", () => {
	let shown = (over: Partial<Parameters<typeof chipShown>[0]> = {}) =>
		chipShown({ agent: true, chip: false, text: "what breaks?", references: [], ...over });

	test("is the state: on once put on, and off until then", () => {
		expect(shown({ chip: true })).toBe(true);
		expect(shown()).toBe(false);
	});

	test("is shown for a message that names Chopin in its words, since that asks it too", () => {
		expect(shown({ text: "can @chopin look?" })).toBe(true);
		expect(shown({ text: "a@chopin.example" })).toBe(false);
	});

	test("is shown for a send already prepared for Chopin, which is held until it goes", () => {
		expect(shown({ submitted: "planner" })).toBe(true);
		expect(shown({ submitted: "room" })).toBe(false);
	});

	test("gives way to a command, which is an address of its own and has no @chopin to take out", () => {
		expect(shown({ chip: true, text: "/plan go", references: [COMMAND] })).toBe(false);
		expect(shown({ text: "/plan go", references: [COMMAND] })).toBe(false);
	});

	test("is never shown where there is no agent", () => {
		expect(shown({ agent: false, chip: true })).toBe(false);
	});
});

describe("taking Chopin out of the words, as removing the chip does", () => {
	let take = (text: string, start = 0, end = start, references: ReferenceDraft[] = []) =>
		withoutChopinMentions(text, references, { start, end });

	test("takes each @chopin typed in the words, and the space it leaned on", () => {
		expect(take("@chopin outline it")).toMatchObject({ text: "outline it" });
		expect(take("so @chopin outline it")).toMatchObject({ text: "so outline it" });
		expect(take("@chopin and @Chopin again")).toMatchObject({ text: "and again" });
		expect(take("outline it @chopin")).toMatchObject({ text: "outline it " });
	});

	test("leaves a word that only looks like it", () => {
		expect(take("mail a@chopin.example")).toMatchObject({ text: "mail a@chopin.example" });
		expect(take("@chopins and @chopina")).toMatchObject({ text: "@chopins and @chopina" });
	});

	test("keeps one inside a reference's own words, and the reference where it moved to", () => {
		// `@chopin See #Export @chopin`: the first is typed, the one in the reference is its title's.
		let text = "@chopin See #Export @chopin";
		let ref: ReferenceDraft = {
			kind: "document",
			channelId: "c",
			start: 12,
			end: 27,
			token: "#Export @chopin",
		};
		let result = take(text, 0, 0, [ref]);
		expect(result.text).toBe("See #Export @chopin");
		expect(result.references).toEqual([{ ...ref, start: 4, end: 19 }]);
	});

	test("moves the caret back by what was taken before it, and not past the start", () => {
		expect(take("@chopin outline it", 12)).toMatchObject({ start: 4, end: 4 });
		expect(take("@chopin outline it", 3)).toMatchObject({ start: 0, end: 0 });
		expect(take("outline it", 4)).toMatchObject({ text: "outline it", start: 4, end: 4 });
	});
});

describe("the chip a restored draft starts with", () => {
	test("is on for a send prepared for Chopin whose words did not name it", () => {
		expect(restoredChip({ text: "what breaks?", references: [] }, "planner")).toBe(true);
	});

	test("is off where the words named Chopin themselves, and for a message to the room or none", () => {
		expect(restoredChip({ text: "@chopin what breaks?", references: [] }, "planner")).toBe(false);
		expect(restoredChip({ text: "what breaks?", references: [] }, "room")).toBe(false);
		expect(restoredChip({ text: "what breaks?", references: [] }, undefined)).toBe(false);
	});
});

describe("what a key does to the chip", () => {
	let at = (selectionStart: number, selectionEnd = selectionStart, chip = true) => ({
		chip,
		selectionStart,
		selectionEnd,
	});

	test("Backspace at the very start of the draft takes the chip off, with words after it or none", () => {
		expect(chipKeyAction({ key: "Backspace" }, at(0))).toBe("remove");
	});

	test("Backspace anywhere else, or with a selection, is the draft's own", () => {
		expect(chipKeyAction({ key: "Backspace" }, at(1))).toBeUndefined();
		expect(chipKeyAction({ key: "Backspace" }, at(0, 4))).toBeUndefined();
		expect(chipKeyAction({ key: "Delete" }, at(0))).toBeUndefined();
	});

	test("Backspace does nothing to a chip that is not there, or while an IME composes", () => {
		expect(chipKeyAction({ key: "Backspace" }, at(0, 0, false))).toBeUndefined();
		expect(chipKeyAction({ key: "Backspace", isComposing: true }, at(0))).toBeUndefined();
		expect(chipKeyAction({ key: "Backspace", keyCode: 229 }, at(0))).toBeUndefined();
	});

	test("Command+J and Control+J put the chip on, wherever the caret is, and never take it off", () => {
		expect(chipKeyAction({ key: "j", metaKey: true }, at(7, 7, false))).toBe("insert");
		expect(chipKeyAction({ key: "J", ctrlKey: true }, at(0, 0, false))).toBe("insert");
		expect(chipKeyAction({ key: "j", ctrlKey: true }, at(3))).toBe("insert");
	});

	test("J with another modifier, or none, is not the shortcut", () => {
		expect(chipKeyAction({ key: "j" }, at(0, 0, false))).toBeUndefined();
		expect(chipKeyAction({ key: "j", metaKey: true, shiftKey: true }, at(0, 0, false)))
			.toBeUndefined();
		expect(chipKeyAction({ key: "j", ctrlKey: true, altKey: true }, at(0, 0, false)))
			.toBeUndefined();
		expect(chipKeyAction({ key: "k", metaKey: true }, at(0, 0, false))).toBeUndefined();
	});

	test("Shift+Tab no longer switches anything", () => {
		expect(chipKeyAction({ key: "Tab", shiftKey: true }, at(0, 0, false))).toBeUndefined();
	});
});

describe("choosing Chopin in the @ menu", () => {
	test("takes the typed @query out, since the chip is what says who it is for", () => {
		let text = "@ch";
		expect(takeChopinMention(text, [], { query: "ch", start: 0, end: 3 })).toEqual({
			text: "",
			references: [],
			caret: 0,
		});
	});

	test("keeps the words around it, and the one space they were separated by", () => {
		expect(takeChopinMention("hello @c", [], { query: "c", start: 6, end: 8 })).toEqual({
			text: "hello ",
			references: [],
			caret: 6,
		});
		expect(takeChopinMention("hello @c world", [], { query: "c", start: 6, end: 8 })).toEqual({
			text: "hello world",
			references: [],
			caret: 6,
		});
		expect(takeChopinMention("@c world", [], { query: "c", start: 0, end: 2 })).toEqual({
			text: "world",
			references: [],
			caret: 0,
		});
	});

	test("moves a reference that follows it and leaves one that came before", () => {
		let before: ReferenceDraft = {
			kind: "document",
			channelId: "a",
			start: 0,
			end: 6,
			token: "#Plans",
		};
		let after: ReferenceDraft = {
			kind: "document",
			channelId: "b",
			start: 10,
			end: 16,
			token: "#Specs",
		};
		let text = "#Plans @c #Specs";
		let result = takeChopinMention(text, [before, after], { query: "c", start: 7, end: 9 });
		expect(result.text).toBe("#Plans #Specs");
		expect(result.references).toEqual([before, { ...after, start: 7, end: 13 }]);
		expect(result.caret).toBe(7);
	});

	test("does nothing to a draft that no longer holds the query it was chosen for", () => {
		expect(takeChopinMention("hello", [], { query: "c", start: 0, end: 2 })).toEqual({
			text: "hello",
			references: [],
			caret: 2,
		});
	});
});

describe("the draft's placeholder", () => {
	test("tells the way to Chopin until the chip says it", () => {
		expect(draftPlaceholder({ agent: true, chip: false })).toBe(
			"Message the team, or @Chopin to ask",
		);
		expect(draftPlaceholder({ agent: true, chip: true })).toBe("Ask Chopin…");
	});

	test("is only for the team where Chopin is off", () => {
		expect(draftPlaceholder({ agent: false, chip: false })).toBe("Message the team");
	});
});
