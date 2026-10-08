import { describe, expect, it } from "bun:test";

import { documentMenuItems, documentMenuKeyAction } from "./document-actions-menu";

describe("document actions menu", () => {
	it("offers only lifecycle-valid actions", () => {
		let summary = (channel: Parameters<typeof documentMenuItems>[0]) =>
			documentMenuItems(channel).map(item => [item.action, item.label, !!item.destructive]);
		expect(summary({})).toEqual([
			["copy-link", "Copy link", false],
			["rename", "Rename", false],
			["archive", "Archive", false],
		]);
		expect(summary({ archivedAt: "2026-08-23T00:00:00.000Z" })).toEqual([
			["restore", "Restore", false],
			["delete", "Delete permanently", true],
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
