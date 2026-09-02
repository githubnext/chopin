import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchIcon } from "@chopin/icons";

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

test("the sidebar and Chat share one panel-close asset", () => {
	let sidebar = readFileSync(join(root, "project-sidebar.tsx"), "utf8");
	let workspace = readFileSync(join(root, "workspace.tsx"), "utf8");

	expect(sidebar).toContain("assets/icons/panel-close.svg");
	expect(workspace).toContain("assets/icons/panel-close.svg");
	expect(existsSync(join(root, "assets/figma/navigation/collapse.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/icons/chat-close.svg"))).toBe(false);
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

test("interface icons default to fourteen pixels", () => {
	let icon = readFileSync(join(repository, "packages/icons/src/icon.tsx"), "utf8");
	let system = readFileSync(join(repository, "packages/icons/src/system.tsx"), "utf8");
	expect(icon).toContain("size = 14");
	expect(system).toContain("LoaderIcon({ size = 14");

	let names = [
		"Archive",
		"ArrowUp",
		"Check",
		"Chevron",
		"Close",
		"Document",
		"Info",
		"Lightbulb",
		"Loader",
		"Message",
		"Plus",
		"Search",
		"SignIn",
		"Siren",
		"Sparkle",
		"Warning",
	].join("|");
	let explicit = new RegExp(`<(?:${names})Icon\\b[^>]*\\bsize=\\{(\\d+)\\}`, "gs");
	let offenders: string[] = [];
	for (
		let file of sourceFiles(join(repository, "apps")).concat(
			sourceFiles(join(repository, "packages")),
		)
	) {
		for (let match of readFileSync(file, "utf8").matchAll(explicit)) {
			let size = Number(match[1]);
			let emptyStateException = file.endsWith("design-audit/surfaces.tsx") && size === 24;
			if (size !== 14 && !emptyStateException) offenders.push(`${file}: ${match[0]}`);
		}
	}
	expect(offenders).toEqual([]);
});

test("interface icons are decorative unless explicitly labelled", () => {
	let decorative = renderToStaticMarkup(createElement(SearchIcon));
	let labelled = renderToStaticMarkup(createElement(SearchIcon, { "aria-label": "Search" }));

	expect(decorative).toContain('aria-hidden="true"');
	expect(labelled).not.toContain('aria-hidden="true"');
});

test("interface icons share one neutral default colour", () => {
	let theme = readFileSync(join(root, "theme.css"), "utf8");
	let icon = readFileSync(join(repository, "packages/icons/src/icon.tsx"), "utf8");
	let system = readFileSync(join(repository, "packages/icons/src/system.tsx"), "utf8");
	expect(theme).toContain("--color-icon: var(--color-gray-500)");
	expect(theme).toMatch(/:where\(\[data-nucleo-icon\]\)\s*{[^}]*color:\s*var\(--color-icon\)/s);
	expect(icon).toContain('data-nucleo-icon=""');
	expect(system).toContain('data-nucleo-icon=""');

	let assetRoots = [
		join(root, "assets/figma/navigation"),
		join(root, "assets/icons"),
	];
	for (let assetRoot of assetRoots) {
		for (let entry of readdirSync(assetRoot)) {
			if (!entry.endsWith(".svg") || entry === "chopin.svg") continue;
			let asset = readFileSync(join(assetRoot, entry), "utf8");
			expect(asset).toContain("#78766e");
			expect(asset).not.toContain("#212121");
		}
	}
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

	expect(room).toContain("ChevronIcon");
	expect(existsSync(join(root, "assets/icons/navigation-chevron-right.svg"))).toBe(false);
	expect(room).not.toContain("tool-chevron-down.svg");
	expect(sidebarChrome).toContain("assets/icons/panel-close.svg");
	expect(existsSync(join(root, "assets/icons/tool-chevron-down.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/icons/tool-chevron-right.svg"))).toBe(false);
	expect(existsSync(join(root, "assets/figma/navigation/sidebar-right-3-hide.svg"))).toBe(false);
});
