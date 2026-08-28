import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let root = import.meta.dir;
let repository = join(root, "../../..");

function sourceFiles(directory: string, found: string[] = []): string[] {
	for (let entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = join(directory, entry);
		if (statSync(path).isDirectory()) sourceFiles(path, found);
		else if (entry.endsWith(".tsx") || entry === "package.json") found.push(path);
	}
	return found;
}

test("the sidebar and conversation share one panel-close asset", () => {
	let sidebar = readFileSync(join(root, "project-sidebar.tsx"), "utf8");
	let workspace = readFileSync(join(root, "workspace.tsx"), "utf8");

	expect(sidebar).toContain("assets/icons/panel-close.svg");
	expect(workspace).toContain("assets/icons/panel-close.svg");
	expect(existsSync(join(root, "assets/figma/navigation/collapse.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/icons/conversation-close.svg"))).toBe(false);
});

test("the interface uses only the shared Nucleo icon family", () => {
	let files = sourceFiles(join(repository, "apps")).concat(
		sourceFiles(join(repository, "packages")),
	);
	for (let file of files) expect(readFileSync(file, "utf8")).not.toContain("@phosphor-icons/react");

	expect(existsSync(join(repository, "packages/icons/src/line.tsx"))).toBe(true);
	expect(readFileSync(join(repository, "packages/icons/src/line.tsx"), "utf8")).toContain(
		"M9,1.75C4.996,1.75",
	);
});

test("directional controls reuse one chevron and one panel icon", () => {
	let room = readFileSync(join(root, "room-workspace.tsx"), "utf8");
	let sidebarChrome = readFileSync(join(root, "project-sidebar-chrome.tsx"), "utf8");

	expect(room).toContain("navigation-chevron-right.svg");
	expect(room).not.toContain("tool-chevron-down.svg");
	expect(sidebarChrome).toContain("assets/icons/panel-close.svg");
	expect(existsSync(join(root, "assets/icons/tool-chevron-down.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/icons/tool-chevron-right.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/figma/navigation/sidebar-right-3-hide.svg"))).toBe(false);
});
