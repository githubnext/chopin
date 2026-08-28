import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let root = import.meta.dir;

test("the sidebar and conversation share one panel-close asset", () => {
	let sidebar = readFileSync(join(root, "project-sidebar.tsx"), "utf8");
	let workspace = readFileSync(join(root, "workspace.tsx"), "utf8");

	expect(sidebar).toContain("assets/icons/panel-close.svg");
	expect(workspace).toContain("assets/icons/panel-close.svg");
	expect(existsSync(join(root, "assets/figma/navigation/collapse.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/icons/conversation-close.svg"))).toBe(false);
});
