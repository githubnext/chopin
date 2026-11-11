import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import postcss from "postcss";

import { LAYER_FILE, layerCss, slotsOf } from "./assistant-ui-layer";
import { RECORDED_MANIFEST } from "./design-contract/registry.mjs";

let root = resolve(import.meta.dir, "..");
let read = (path: string) => readFileSync(join(root, path), "utf8");
let tailwindPath = createRequire(join(root, "apps/web/package.json")).resolve(
	"tailwindcss/theme.css",
);
let tailwind = readFileSync(tailwindPath, "utf8");
let chopin = read("packages/visuals/theme.css");
let recorded: { file: string }[] = JSON.parse(read(RECORDED_MANIFEST)).files;
let copiedSources = recorded.filter(entry => /\.tsx?$/.test(entry.file));
let slots = copiedSources.flatMap(entry => slotsOf(read(entry.file)));

function variables(css: string, select: (rule: postcss.Rule | postcss.AtRule) => boolean) {
	let found = new Map<string, string>();
	postcss.parse(css).walk(node => {
		if ((node.type !== "rule" && node.type !== "atrule") || !select(node)) return;
		for (let child of node.nodes ?? []) {
			if (child.type === "decl" && child.prop.startsWith("--")) found.set(child.prop, child.value);
		}
	});
	return found;
}

let layer = read(LAYER_FILE);
let tailwindOwn = variables(
	tailwind,
	node => node.type === "atrule" && node.name === "theme" && node.params === "default",
);
let scoped = variables(layer, node => node.type === "rule" && node.selector.startsWith(":where("));
let dropped = variables(layer, node => node.type === "atrule" && node.name === "theme");
let chopinOwn = variables(chopin, node => node.type === "atrule" && node.name === "theme");

function sources(directory: string, found: string[] = []): string[] {
	for (let entry of readdirSync(join(root, directory))) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = `${directory}/${entry}`;
		if (statSync(join(root, path)).isDirectory()) sources(path, found);
		else if (/\.tsx?$/.test(entry) && !/\.(test|e2e)\./.test(entry)) found.push(path);
	}
	return found;
}

describe("the assistant-ui geometry layer", () => {
	test("is what the generator writes now, so it cannot be edited or left behind", () => {
		expect(layerCss({ tailwind, chopin, slots })).toBe(layer);
	});

	test("restores Tailwind's own value for everything on a copy's root, and invents none", () => {
		expect(scoped.size).toBeGreaterThan(20);
		for (let [name, value] of scoped) expect(tailwindOwn.get(name)).toBe(value);
	});

	test("is Tailwind's scale where Chopin's is not: assistant-ui's radii, 14px and 12px type", () => {
		expect(scoped.get("--radius-sm")).toBe("0.25rem");
		expect(scoped.get("--radius-md")).toBe("0.375rem");
		expect(scoped.get("--radius-lg")).toBe("0.5rem");
		expect(scoped.get("--radius-xl")).toBe("0.75rem");
		expect(scoped.get("--radius-2xl")).toBe("1rem");
		expect(scoped.get("--text-xs")).toBe("0.75rem");
		expect(scoped.get("--text-xs--line-height")).toBe("calc(1 / 0.75)");
		expect(scoped.get("--text-sm")).toBe("0.875rem");
		expect(scoped.get("--text-sm--line-height")).toBe("calc(1.25 / 0.875)");
		expect(scoped.get("--spacing")).toBe("0.25rem");
	});

	test("declares globally only what Chopin's theme dropped, never a value of its own", () => {
		expect(dropped.size).toBeGreaterThan(10);
		for (let [name, value] of dropped) {
			expect(chopinOwn.has(name)).toBe(false);
			expect(scoped.get(name)).toBe(value);
		}
		expect(dropped.has("--radius-2xl")).toBe(true);
		expect(dropped.has("--radius-xl")).toBe(false);
	});

	test("is scoped to every root the copies set, and Chopin's own elements are not among them", () => {
		let scope = layer.slice(layer.indexOf(":where("), layer.indexOf(") {"));
		for (let slot of new Set(slots)) expect(scope).toContain(`[data-slot="${slot}"]`);
		let recordedFiles = new Set(recorded.map(entry => entry.file));
		let owned = ["apps", "packages"].flatMap(directory => sources(directory))
			.filter(file => !recordedFiles.has(file));
		for (let file of owned) {
			for (let slot of slotsOf(read(file))) {
				expect({ file, slot, scoped: slots.includes(slot) }).toEqual({ file, slot, scoped: false });
			}
		}
	});

	test("gives a coarse pointer an invisible target and never a bigger visible box", () => {
		let hit = layer.slice(layer.indexOf("@layer components"));
		expect(hit).toContain(":root[data-plan-coarse-pointer]");
		expect(hit).toContain("::after");
		expect(hit).toContain("width: max(100%, var(--control-target-coarse))");
		expect(hit).not.toMatch(/min-(width|height)/);
	});
});

describe("assistant-ui's colours", () => {
	let css = read("apps/web/src/assistant-ui.css");
	let sheet = postcss.parse(css);
	let block = (selector: string) => {
		let found = new Map<string, string>();
		sheet.walkRules(selector, rule =>
			rule.walkDecls(decl => {
				found.set(decl.prop, decl.value);
			}));
		return found;
	};
	let ROLES = [
		"background",
		"foreground",
		"muted",
		"muted-foreground",
		"accent",
		"accent-foreground",
		"border",
		"input",
		"ring",
		"popover",
		"popover-foreground",
		"primary",
		"primary-foreground",
		"secondary",
		"destructive",
	];
	let tokens = new Set([...chopinOwn.keys(), "--focus-ring-color"]);

	test("every role is mapped in light and dark", () => {
		for (let scope of [":root", ".dark"]) {
			let mapped = block(scope);
			for (let role of ROLES) {
				expect([scope, role, mapped.has(`--${role}`)]).toEqual([scope, role, true]);
			}
		}
	});

	test("every role reads a colour token Chopin's theme defines, and nothing else", () => {
		for (let scope of [":root", ".dark"]) {
			for (let [name, value] of block(scope)) {
				let token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
				expect([scope, name, value, token !== undefined && tokens.has(token)]).toEqual([
					scope,
					name,
					value,
					true,
				]);
			}
		}
	});

	test("draws no ring, shadow or fill that assistant-ui does not: its hairline edge, not a button's", () => {
		let mapped = block(":root");
		for (let role of ["border", "input"]) expect(mapped.get(`--${role}`)).toBe("var(--color-edge)");
		for (let value of mapped.values()) {
			expect(value).not.toContain("outline-edge");
			expect(value).not.toContain("control-edge");
			expect(value).not.toContain("shadow");
			expect(value).not.toContain("--color-selected");
		}
		expect(mapped.get("--ring")).toBe("var(--focus-ring-color)");
	});

	test("the dark scope reads the same tokens while Chopin has no dark theme", () => {
		expect(block(".dark")).toEqual(block(":root"));
	});

	test("every role has its Tailwind colour, except the one Chopin already names", () => {
		let theme = variables(css, node => node.type === "atrule" && node.name === "theme");
		for (let role of ROLES.filter(role => role !== "destructive")) {
			expect(theme.get(`--color-${role}`)).toBe(`var(--${role})`);
		}
		expect(theme.has("--color-destructive")).toBe(false);
		expect(chopinOwn.has("--color-destructive")).toBe(true);
	});
});
