import { describe, expect, test } from "bun:test";

import { documentEditMode, opensEditing, selectionOffer } from "./edit-mode";

describe("documentEditMode", () => {
	test("phones read until a writer asks to edit", () => {
		expect(documentEditMode({ canEdit: true, editing: false, phone: true })).toBe("reading");
		expect(documentEditMode({ canEdit: true, editing: true, phone: true })).toBe("editing");
	});

	test("desktop and viewers have no mode", () => {
		expect(documentEditMode({ canEdit: true, editing: false, phone: false })).toBeUndefined();
		expect(documentEditMode({ canEdit: true, editing: true, phone: false })).toBeUndefined();
		// Permission wins: a viewer is read-only, not reading.
		expect(documentEditMode({ canEdit: false, editing: true, phone: true })).toBeUndefined();
	});
});

describe("opensEditing", () => {
	test("new and empty documents open editing", () => {
		expect(opensEditing({ renaming: true })).toBe(true);
		expect(opensEditing({ empty: true })).toBe(true);
		expect(opensEditing({ empty: false })).toBe(false);
		expect(opensEditing({})).toBe(false);
	});
});

describe("selectionOffer", () => {
	test("reading keeps commenting", () => {
		expect(selectionOffer({ docked: false, locked: false, mode: "reading" })).toBe("comment");
	});

	test("any other lock offers nothing, even while reading", () => {
		expect(selectionOffer({ docked: false, locked: true, mode: "reading" })).toBe("none");
		expect(selectionOffer({ docked: false, locked: true })).toBe("none");
	});

	test("the docked toolbar replaces the bubble while editing", () => {
		expect(selectionOffer({ docked: true, locked: false, mode: "editing" })).toBe("none");
		expect(selectionOffer({ docked: false, locked: false, mode: "editing" })).toBe("format");
	});

	test("desktop formats as before", () => {
		expect(selectionOffer({ docked: false, locked: false })).toBe("format");
	});
});
