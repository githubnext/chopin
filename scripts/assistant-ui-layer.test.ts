import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import postcss from "postcss";

import { LAYER_FILE, layerCss, slotsOf, tinted } from "./assistant-ui-layer";
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
let scoped = variables(
	layer,
	node =>
		node.type === "rule" && node.selector.startsWith("[data-slot|=")
		&& !node.selector.includes("chopin-control"),
);
let ownControl = variables(
	layer,
	node => node.type === "rule" && node.selector === "[data-chopin-control]",
);
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
		for (let [name, value] of scoped) {
			// Only a colour is Chopin's: a shadow is Tailwind's at the same opacity, tinted.
			expect(value).toBe(
				/shadow/.test(name) ? tinted(tailwindOwn.get(name)!) : tailwindOwn.get(name),
			);
		}
	});

	test("draws a shadow in Chopin's tint, never raw black", () => {
		let shadows = [...scoped, ...dropped].filter(([name]) => /shadow/.test(name));
		expect(shadows.length).toBeGreaterThan(10);
		for (let [, value] of shadows) {
			expect(value).not.toMatch(/rgb\(0 0 0/);
			expect(value).toContain("oklch(var(--shadow-color) /");
		}
	});

	test("reads no universal selector under a copy: a `*` rule makes every element walk its ancestors", () => {
		expect(layer).not.toMatch(/\)\s*\*\s*[,{]/);
	});

	test("colours a bare border with the border role, found by its class and in the base layer", () => {
		let base = layer.slice(
			layer.indexOf("@layer base"),
			layer.indexOf("/*", layer.indexOf("@layer base")),
		);
		expect(base).toContain("border-color: var(--color-border)");
		for (let name of ["border", "border-t", "border-b", "border-x"]) {
			expect(base).toContain(`.${name}:not([data-chopin-control])`);
		}
		// No subject that every element has, and a Chopin control keeps its own.
		expect(base).not.toContain("[class*=");
		expect(base).not.toMatch(/(^|,)\s*\*\s*[,{]/m);
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
		// By the first word of a slot (`command` is `command-item` and the rest): a handful of selectors.
		let words = [...new Set(slots.map(slot => slot.split("-")[0]!))];
		let scope = layer.slice(
			layer.indexOf('[data-slot|="'),
			layer.indexOf("{", layer.indexOf('[data-slot|="')),
		);
		for (let word of words) expect(scope).toContain(`[data-slot|="${word}"]`);
		expect(words.length).toBeLessThan(slots.length);
		let recordedFiles = new Set(recorded.map(entry => entry.file));
		let owned = ["apps", "packages"].flatMap(directory => sources(directory))
			.filter(file => !recordedFiles.has(file));
		for (let file of owned) {
			for (let slot of slotsOf(read(file))) {
				let word = slot.split("-")[0]!;
				expect({ file, slot, scoped: words.includes(word) }).toEqual({ file, slot, scoped: false });
			}
		}
	});

	test("tries only subjects the browser can find by tag, class or attribute, never one every element has", () => {
		// `:is(a, b)` or `:where(...)` as a subject, `*`, `[class*=]`: each is tried on every element on
		// every style recalculation, and the last was enough to miss a 100ms browser spec's budget.
		let selectors = [...layer.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
			.map(match => match[1]!.trim()).filter(selector => !selector.startsWith("@"));
		let top = (text: string, separator: RegExp) => {
			let parts: string[] = [];
			let depth = 0;
			let current = "";
			for (let character of text) {
				if (character === "(" || character === "[") depth++;
				if (character === ")" || character === "]") depth--;
				if (depth === 0 && separator.test(character)) {
					if (current.trim()) parts.push(current.trim());
					current = "";
				} else current += character;
			}
			if (current.trim()) parts.push(current.trim());
			return parts;
		};
		let complex = selectors.flatMap(list => top(list, /,/));
		expect(complex.length).toBeGreaterThan(40);
		for (let selector of complex) {
			// The subject is the last compound after the last combinator.
			let subject = top(selector, /\s/).at(-1)!;
			expect(subject, selector).not.toMatch(/^(:is\(|:where\(|\*|\[class\*=)/);
		}
	});

	test("hands a Chopin control inside a copy back its own scale, focus ring, press and touch rules", () => {
		// Chopin's values, from its own theme, for exactly the variables the roots restored that it declares.
		expect(ownControl.size).toBeGreaterThan(10);
		for (let [name, value] of ownControl) {
			expect(scoped.has(name)).toBe(true);
			expect(chopinOwn.get(name)).toBe(value);
		}
		expect(ownControl.get("--text-sm")).toBe(chopinOwn.get("--text-sm"));
		expect(ownControl.get("--radius-xl")).toBe("0.625rem");
		// Every rule that reverts a Chopin behaviour for a copy skips a control that opts out.
		let reverts = [...layer.matchAll(/([^{}]*)\{\s*(?:transition|scale|outline): revert-layer/g)];
		expect(reverts.length).toBeGreaterThanOrEqual(3);
		for (let [rule] of reverts) expect(rule).toContain(":not([data-chopin-control])");
		let hit = layer.slice(layer.indexOf("@layer components"));
		expect(hit).toContain(":not([data-chopin-control])");
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

	test("every raw palette colour a copy names is a Chopin role: accent blue is petrol, green and red are its own", () => {
		let theme = variables(css, node => node.type === "atrule" && node.name === "theme");
		let used = new Set<string>();
		for (let file of recorded.filter(entry => entry.file.endsWith(".tsx"))) {
			for (
				let match of read(file.file).matchAll(
					/(?:bg|text|border|ring|caret|fill|stroke|from|to|via|outline|decoration|inset-ring)-(blue|emerald|red|green|amber|yellow|orange|purple|pink|rose|sky|indigo|violet|teal|cyan|lime|fuchsia|slate|gray|zinc|neutral|stone)-\d+/g,
				)
			) used.add(`--color-${match[1]}-${match[0].match(/\d+$/)![0]}`);
		}
		expect([...used].sort()).toEqual([...used].filter(name => theme.has(name)).sort());
		expect(theme.get("--color-blue-500")).toBe("var(--color-brand)");
		expect(theme.get("--color-blue-400")).toBe("var(--color-brand)");
		expect(theme.get("--color-emerald-500")).toBe("var(--color-success)");
		// The red of an icon or a ring is the destructive one; the red a copy writes words in
		// (`text-red-600`, a file's reason) is Chopin's danger text, because the destructive red does
		// not reach the contrast of text on a soft fill (the chip's browser spec runs axe on it).
		for (let shade of ["400", "500"]) {
			expect(theme.get(`--color-red-${shade}`)).toBe("var(--color-destructive)");
		}
		expect(theme.get("--color-red-600")).toBe("var(--color-danger-text)");
	});

	test("every role has its Tailwind colour, except the one Chopin already names", () => {
		let theme = variables(css, node => node.type === "atrule" && node.name === "theme");
		for (let role of ROLES.filter(role => role !== "destructive")) {
			expect(theme.get(`--color-${role}`)).toBe(`var(--${role})`);
		}
		expect(theme.has("--color-destructive")).toBe(false);
		expect(chopinOwn.has("--color-destructive")).toBe(true);
	});

	test("splits the copies' stylesheet from the entry theme, keeping Tailwind's layer order", () => {
		let webTheme = read("apps/web/src/theme.css");
		expect(webTheme).not.toContain("assistant-ui.css");
		expect(webTheme).toContain('@source not "./components";');
		let firstLayer = sheet.nodes.find(
			node => node.type === "atrule" && node.name === "layer",
		);
		expect(firstLayer?.type === "atrule" ? firstLayer.params : undefined).toBe(
			"theme, base, components, utilities",
		);
		expect(css).toContain('@source "./components";');
		expect(css).toContain('@import "@chopin/visuals/theme.css" reference;');
	});
});
