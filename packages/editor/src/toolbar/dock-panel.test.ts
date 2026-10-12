import { expect, test } from "bun:test";

import { insertChoices, keyboardCover, styleChoices } from "./dock-panel";

test("a panel takes the height the software keyboard covered", () => {
	expect(keyboardCover(844, { top: 0, height: 500 })).toBe(344);
	// A page the browser scrolled up under the keyboard still measures from the layout bottom.
	expect(keyboardCover(844, { top: 40, height: 460 })).toBe(344);
});

test("browser toolbars and missing viewports are not a keyboard", () => {
	expect(keyboardCover(844, { top: 0, height: 780 })).toBeUndefined();
	expect(keyboardCover(844, undefined)).toBeUndefined();
});

test("Insert offers the slash menu's blocks, and Research only where the host has it", () => {
	let plain = insertChoices(false).map(choice => choice.id);
	expect(plain).toContain("table");
	expect(plain).not.toContain("research");
	// Task list is a text style, offered there instead.
	expect(plain).not.toContain("tasks");
	expect(insertChoices(true).map(choice => choice.id).at(-1)).toBe("research");
});

test("Text style marks the caret's current block", () => {
	let choices = styleChoices("h2");
	expect(choices.filter(choice => choice.current).map(choice => choice.label)).toEqual([
		"Heading 2",
	]);
	expect(choices.map(choice => choice.label)).toEqual([
		"Text",
		"Heading 1",
		"Heading 2",
		"Heading 3",
		"Quote",
		"Bulleted list",
		"Numbered list",
		"Task list",
	]);
});
