import { describe, expect, it } from "bun:test";

import { documentMenuItems, documentMenuKeyAction } from "./document-actions-menu";

describe("document actions menu", () => {
	it("offers only lifecycle-valid actions", () => {
		expect(documentMenuItems({})).toEqual([
			{ action: "rename", label: "Rename" },
			{ action: "archive", label: "Archive" },
		]);
		expect(documentMenuItems({ archivedAt: "2026-08-23T00:00:00.000Z" })).toEqual([
			{ action: "restore", label: "Restore" },
			{ action: "delete", label: "Delete permanently", destructive: true },
		]);
	});

	it("maps standard menu navigation keys without consuming unrelated keys", () => {
		expect(documentMenuKeyAction("ArrowDown")).toBe("next");
		expect(documentMenuKeyAction("ArrowUp")).toBe("previous");
		expect(documentMenuKeyAction("Home")).toBe("first");
		expect(documentMenuKeyAction("End")).toBe("last");
		expect(documentMenuKeyAction("Escape")).toBe("close");
		expect(documentMenuKeyAction("Tab")).toBeUndefined();
	});
});
