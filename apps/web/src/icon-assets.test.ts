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

	let icons = readFileSync(join(repository, "packages/icons/src/line.tsx"), "utf8");
	expect(icons).toContain("M9,1.75C4.996,1.75");
	expect(icons).toContain("M9.75,2.75h3.5");
	expect(icons).toContain("M4.75 13.25V9");
	expect(icons).toContain("10.912 7.087 15.75 9");
	expect(icons).toContain("M7.63796 3.48996");
	expect(icons).toContain('x1="9" x2="9" y1="3.25" y2="14.75"');
});

test("the design audit presents one Nucleo icon catalogue", () => {
	let catalogue = readFileSync(join(root, "design-audit/icons.tsx"), "utf8");
	let foundations = readFileSync(join(root, "design-audit/foundations.tsx"), "utf8");

	expect(catalogue).toContain("Nucleo icons");
	expect(catalogue).not.toContain("Local SVG assets");
	expect(catalogue).not.toContain("Nucleo components");
	expect(foundations).toContain("Every Nucleo icon currently used by the interface.");
});

test("callouts use their distinct semantic Nucleo icons", () => {
	let callout = readFileSync(join(repository, "packages/editor/src/widgets/callout.tsx"), "utf8");
	expect(callout).toContain('case "important":\n\t\t\treturn <SparkleIcon');
	expect(callout).toContain('case "warning":\n\t\t\treturn <WarningIcon');
	expect(callout).toContain('case "danger":\n\t\t\treturn <SirenIcon');
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
