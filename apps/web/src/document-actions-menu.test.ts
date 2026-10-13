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

	it("offers roster personas only for an open, unarchived document", () => {
		let roster = [
			{ id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" },
			{ id: "demo:felix", name: "Felix", avatar: "/demo/felix.svg" },
		];
		let actions = (channel: Parameters<typeof documentMenuItems>[0], list = roster) =>
			documentMenuItems(channel, list).map(item => item.action);
		expect(actions({})).toEqual([
			"copy-link",
			"rename",
			"collaborator:demo:lily",
			"collaborator:demo:felix",
			"archive",
		]);
		expect(actions({}, [])).toEqual(["copy-link", "rename", "archive"]);
		expect(actions({ archivedAt: "2026-08-23T00:00:00.000Z" })).toEqual(["restore", "delete"]);
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
