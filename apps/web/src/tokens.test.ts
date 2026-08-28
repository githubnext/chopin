/**
 * The design-system contract.
 *
 * `theme.test.ts` checks the visibility of document marks. These tests check
 * the system those marks sit inside: resolved colours, scale membership and
 * whether every consumer has left the vocabulary this system replaces.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Oklch = { l: number; c: number; h: number };

const ROOT = join(import.meta.dir, "../../..");
const THEME = readFileSync(join(import.meta.dir, "theme.css"), "utf8");
const EDITOR_STYLES = readFileSync(join(ROOT, "packages/editor/src/styles.css"), "utf8");

function declared(name: string): string {
	let found = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(THEME);
	if (!found) throw new Error(`no ${name} in the theme`);
	return found[1]!.trim().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

function resolved(name: string): string {
	let value = declared(name);
	let alias = /^var\((--[\w-]+)\)$/.exec(value);
	return alias ? resolved(alias[1]!) : value;
}

function colour(name: string): Oklch {
	let found = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(resolved(name));
	if (!found) throw new Error(`${name} is not an opaque oklch colour`);
	return { l: Number(found[1]), c: Number(found[2]), h: Number(found[3]) };
}

function linearChannels(value: Oklch): number[] {
	let radians = (value.h * Math.PI) / 180;
	let a = value.c * Math.cos(radians);
	let b = value.c * Math.sin(radians);
	let long = (value.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (value.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (value.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];
}

function hex(name: string): string {
	let channels = linearChannels(colour(name));
	return `#${
		channels.map(channel => {
			let encoded = channel <= 0.0031308
				? 12.92 * channel
				: 1.055 * Math.pow(Math.max(channel, 0), 1 / 2.4) - 0.055;
			return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
				.toString(16)
				.padStart(2, "0");
		}).join("")
	}`;
}

function luminance(name: string): number {
	let [red, green, blue] = linearChannels(colour(name));
	return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(foreground: string, background: string): number {
	let lighter = Math.max(luminance(foreground), luminance(background));
	let darker = Math.min(luminance(foreground), luminance(background));
	return (lighter + 0.05) / (darker + 0.05);
}

function sources(dir: string, found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, found);
		else if (entry.endsWith(".tsx") || entry.endsWith(".css")) found.push(path);
	}
	return found;
}

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function utility(name: string): string {
	let start = THEME.indexOf(`@utility ${name} {`);
	if (start === -1) throw new Error(`no ${name} utility in the theme`);

	let depth = 0;
	for (let index = THEME.indexOf("{", start); index < THEME.length; index++) {
		if (THEME[index] === "{") depth++;
		if (THEME[index] === "}") depth--;
		if (depth === 0) return THEME.slice(start, index + 1);
	}

	throw new Error(`unterminated ${name} utility in the theme`);
}

function sizes(name: string): { height: number; width?: number } {
	let result: { height: number; width?: number } = { height: 0 };
	for (let property of ["height", "width"] as const) {
		let found = new RegExp(`\\n\\s*${property}:\\s*([\\d.]+)rem;`).exec(utility(name));
		if (found) result[property] = Number(found[1]) * 16;
	}
	return result;
}

function inlinePadding(name: string): string | undefined {
	let found = /\n\s*padding-inline:\s*([^;]+);/.exec(utility(name));
	return found?.[1]?.trim();
}

describe("palette", () => {
	let steps = [50, 100, 150, 200, 300, 400, 500, 600, 700, 750, 800, 850, 900, 950];

	it("keeps all fourteen neutral steps on the warm olive axis", () => {
		for (let step of steps) expect(colour(`--color-gray-${step}`).h).toBe(95);
	});

	it("resolves the settled specimens exactly", () => {
		expect(hex("--color-gray-100")).toBe("#f8f8f6");
		expect(hex("--color-gray-150")).toBe("#f4f4f1");
		expect(hex("--color-brand")).toBe("#06707e");
		expect(hex("--color-destructive")).toBe("#d54d4c");
	});

	it("keeps the Chat body ink distinct from the general secondary text", () => {
		expect(declared("--color-chat-body")).toBe("#3e453b");
	});

	it("washes the Chat pane with thirty percent of the app shell", () => {
		expect(declared("--color-chat-pane")).toBe(
			"color-mix(in srgb, var(--color-ground) 30%, var(--color-page))",
		);
	});

	it("tunes the light semantic washes independently", () => {
		expect(declared("--color-brand-wash")).toBe("oklch(0.925 0.02 210)");
		expect(declared("--color-success-wash")).toBe("oklch(0.93 0.026 145)");
		expect(declared("--color-warning-wash")).toBe("oklch(0.95 0.032 75)");
		expect(declared("--color-destructive-wash")).toBe(
			"color-mix(in srgb, var(--color-destructive) 20%, var(--color-page))",
		);
	});

	it("keeps the Chat pane edge subtly stronger than the frame hairline", () => {
		expect(THEME).toMatch(
			/\.workspace-frame \.workspace-chat-panel\s*\{\s*border-color:\s*rgb\(0 0 0 \/ 9%\);/,
		);
	});

	it("gives every text level at least AA contrast on the page", () => {
		for (let level of ["primary", "secondary", "tertiary", "quaternary"]) {
			let ratio = contrast(`--color-text-${level}`, "--color-page");
			expect({ level, passes: ratio >= 4.5 }).toEqual({ level, passes: true });
		}
	});

	it("keeps text used on tinted surfaces at AA contrast", () => {
		for (let surface of ["ground", "hover", "selected"]) {
			let ratio = contrast("--color-text-tertiary", `--color-${surface}`);
			expect({ surface, passes: ratio >= 4.5 }).toEqual({ surface, passes: true });
		}
	});

	it("uses selected as the single passive control fill", () => {
		expect(THEME).not.toMatch(/\n\s*--color-control(?:-hover)?:/);
		expect(EDITOR_STYLES).not.toContain("var(--color-control)");
		for (
			let source of sources(join(ROOT, "apps/web/src")).concat(sources(join(ROOT, "packages")))
		) {
			expect(withoutComments(readFileSync(source, "utf8"))).not.toMatch(/\bbg-control\b/);
		}
	});

	it("keeps petrol as the only blue family", () => {
		let blue = [...THEME.matchAll(/\n\s*(--color-[\w-]+):\s*oklch\([\d.]+\s+[\d.]+\s+([\d.]+)/g)]
			.filter(match => Number(match[2]) >= 180 && Number(match[2]) <= 270)
			.map(match => match[1]);
		expect(blue).toEqual([
			"--color-brand",
			"--color-brand-hover",
			"--color-brand-active",
			"--color-brand-wash",
			"--color-brand-ink",
		]);
	});
});

describe("type", () => {
	it("has exactly the five designed rungs", () => {
		let found = [...THEME.matchAll(/\n\s*(--text-(?![\w-]*--line-height)[\w-]+):\s*([\d.]+rem);/g)]
			.map(match => [match[1], Number.parseFloat(match[2]!) * 16]);
		expect(found).toEqual([
			["--text-sm", 13],
			["--text-base", 15],
			["--text-lg", 17],
			["--text-xl", 24],
			["--text-2xl", 32],
		]);
	});

	it("pairs every rung with its designed line height", () => {
		expect(["sm", "base", "lg", "xl", "2xl"].map(name => declared(`--text-${name}--line-height`)))
			.toEqual(["1.25rem", "1.375rem", "1.6875rem", "1.875rem", "2.375rem"]);
	});
});

describe("edges and depth", () => {
	it("has only a passive edge and a control edge", () => {
		let edges = [...THEME.matchAll(/\n\s*(--color-[\w-]*edge):/g)].map(match => match[1]);
		expect(edges).toEqual(["--color-edge", "--color-control-edge"]);
		expect(declared("--color-edge")).toBe("rgb(0 0 0 / 7%)");
		expect(declared("--color-control-edge")).toBe("rgb(0 0 0 / 20%)");
	});

	it("keeps the control boundary visible on every surface", () => {
		for (let surface of ["page", "ground", "hover", "selected"]) {
			let ratio = contrast("--color-control-boundary", `--color-${surface}`);
			expect({ surface, passes: ratio >= 3 }).toEqual({ surface, passes: true });
		}
	});

	it("halves the hairline on retina displays", () => {
		expect(declared("--edge-width")).toBe("1px");
		expect(THEME).toMatch(/@media \(min-resolution: 2dppx\)[\s\S]+--edge-width:\s*0\.5px/);
	});

	it("provides exactly the four designed shadows", () => {
		let found = [...THEME.matchAll(/\n\s*(--shadow-(?!color)[\w-]+):/g)].map(match => match[1]);
		expect(found).toEqual([
			"--shadow-resting",
			"--shadow-resting-strong",
			"--shadow-raised",
			"--shadow-overlay",
		]);
		expect(declared("--shadow-color")).toBe("14 13 10");
		expect(EDITOR_STYLES).toMatch(
			/\[data-research-ready\]\s*\{\s*box-shadow:\s*var\(--shadow-resting-strong\)/,
		);
	});
});

describe("controls", () => {
	it("exposes the settled button sizes and destructive states", () => {
		expect(sizes("btn-md")).toEqual({ height: 32 });
		expect(sizes("btn-sm")).toEqual({ height: 24 });
		expect(sizes("btn-icon")).toEqual({ height: 28, width: 28 });
		expect(inlinePadding("btn-md")).toBe("calc(var(--spacing) * 3)");
		expect(inlinePadding("btn-sm")).toBe("calc(var(--spacing) * 2)");
		expect(utility("btn-icon")).toMatch(/\n\s*padding:\s*0\.375rem;/);
		expect(hex("--color-destructive-hover")).toBe("#c44746");
		expect(hex("--color-destructive-active")).toBe("#b34140");
	});

	it("gives every button tier guarded states without a rest border", () => {
		for (let tier of ["primary", "secondary", "ghost", "destructive"]) {
			let rule = utility(`btn-${tier}`);
			expect(rule).toMatch(/&:hover:not\(:disabled\)/);
			expect(rule).toMatch(/&:active:not\(:disabled\)/);
			expect(rule.slice(0, rule.indexOf("&:"))).not.toMatch(/\bborder(?:-\w+)?:/);
		}
	});

	it("uses the common disabled button fill and ink", () => {
		let rule = utility("btn");
		expect(rule).toMatch(/&:disabled\s*\{[\s\S]*background-color:\s*var\(--color-gray-200\)/);
		expect(rule).toMatch(/&:disabled\s*\{[\s\S]*color:\s*var\(--color-gray-600\)/);
	});

	it("requires every shared button consumer to choose a size", () => {
		let offenders: string[] = [];
		for (let file of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
			if (!file.endsWith(".tsx")) continue;
			let lines = readFileSync(file, "utf8").split("\n");
			for (let [index, line] of lines.entries()) {
				if (!line.includes("className=") || !/(?<![\w-])btn(?![\w-])/.test(line)) continue;
				if (/\bbtn-(?:md|sm|icon)\b/.test(line)) continue;
				offenders.push(`${relative(ROOT, file)}:${index + 1}`);
			}
		}

		expect(offenders).toEqual([]);
	});

	it("keeps button labels on one line", () => {
		expect(utility("btn")).toMatch(/white-space:\s*nowrap/);
	});

	it("keeps consumer classes from resizing standard icon buttons", () => {
		expect(EDITOR_STYLES).not.toMatch(/\.plan-research-dismiss\s*\{[^}]*(?:width|height):/s);
	});

	it("distinguishes the active compact workspace destination", () => {
		expect(THEME).toMatch(
			/\.workspace-navigation \[aria-current="page"\]\s*\{[\s\S]*background-color:\s*var\(--color-page\);[\s\S]*color:\s*var\(--color-text-primary\)/,
		);
	});

	it("keeps focus and invalid outlines visible above their surface", () => {
		expect(declared("--focus-ring-color")).toBe("var(--color-brand)");
		expect(declared("--focus-ring-width")).toBe("2px");
		expect(declared("--focus-ring-offset")).toBe("2px");
		expect(THEME).toMatch(
			/\[data-focus-boundary\]\s*\{[\s\S]*--focus-ring-offset:\s*-2px/,
		);
		expect(THEME).toMatch(
			/:focus-visible\s*\{[\s\S]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\);[\s\S]*outline-offset:\s*var\(--focus-ring-offset\)/,
		);
		expect(utility("field")).toMatch(
			/&\[aria-invalid="true"\]\s*\{[\s\S]*outline:\s*2px solid var\(--color-destructive\);[\s\S]*outline-offset:\s*2px/,
		);
	});

	it("puts Chat focus around the complete composer rather than its textarea", () => {
		expect(THEME).toContain(".chat-composer .field:focus-within");
		expect(THEME).toContain(".chat-composer textarea:focus");
	});

	it("uses the two designed control edges across fields and choices", () => {
		for (let name of ["field", "choice-control"]) {
			let rule = utility(name);
			expect(rule).toMatch(/border:\s*var\(--edge-width\) solid var\(--color-control-edge\)/);
			expect(rule).toMatch(/&:disabled\s*\{[\s\S]*border-color:\s*var\(--color-edge\)/);
		}
		expect(utility("field")).toMatch(
			/&:disabled\s*\{[\s\S]*background-color:\s*var\(--color-gray-200\)/,
		);
		expect(utility("choice-control")).toMatch(
			/&:disabled\s*\{[\s\S]*color:\s*var\(--color-gray-600\)/,
		);
	});

	it("keeps the checked checkbox glyph", () => {
		expect(utility("choice-control")).toContain("d='m3 7 2.5 2.5L11 4'");
	});

	it("keeps a disabled checked checkbox's fill distinct from its glyph", () => {
		let rule = utility("choice-control");
		let checked = rule.indexOf("&:disabled:checked");
		let checkbox = rule.indexOf('&[type="checkbox"]:disabled:checked');

		expect(checkbox).toBeGreaterThan(checked);
		expect(rule.slice(checkbox)).toMatch(
			/background-color:\s*var\(--color-gray-200\);[\s\S]*stroke='%23605e56'/,
		);
	});

	it("keeps ghost fields transparent until hovered", () => {
		let rule = utility("field-ghost");
		expect(rule).toMatch(/background-color:\s*transparent/);
		expect(rule).toMatch(
			/&:hover:not\(:disabled\)\s*\{[\s\S]*border-color:\s*var\(--color-control-edge\)/,
		);
	});
});

describe("consumer roles", () => {
	it("uses the shared icon library instead of literal interface artwork", () => {
		let offenders: string[] = [];
		for (let file of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
			if (file.startsWith(join(ROOT, "packages/icons/"))) continue;
			let content = withoutComments(readFileSync(file, "utf8"));
			if (/<svg\b/.test(content) || /[\u{1F300}-\u{1FAFF}]/u.test(content)) {
				offenders.push(relative(ROOT, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps gray-400 out of text", () => {
		for (let file of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
			expect(withoutComments(readFileSync(file, "utf8"))).not.toMatch(
				/(?:^|\n)\s*color:\s*var\(--color-gray-400\)|text-gray-400/,
			);
		}
	});

	it("keeps placeholders on an opaque AA text role", () => {
		for (let file of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
			let content = withoutComments(readFileSync(file, "utf8"));
			expect(content).not.toMatch(/placeholder:text-text-quaternary(?:\/\d+)?/);
		}
	});
});

type StandardAction = {
	action: string;
	marker: string;
	size: "btn-sm" | "btn-md" | "btn-icon";
	tiers: readonly ("btn-primary" | "btn-secondary" | "btn-ghost" | "btn-destructive")[];
};

function classLists(button: string): string[][] {
	let attribute = button.slice(button.indexOf("className="));
	let staticClass = /^className="([^"]+)"/.exec(attribute)?.[1];
	if (staticClass) return [staticClass.split(/\s+/)];

	let templateClass = /^className=\{`([^`]*)`\}/.exec(attribute)?.[1];
	if (templateClass) return [templateClass.split(/\s+/)];

	let expression = /^className=\{([^}]*)\}/.exec(attribute)?.[1];
	if (!expression) return [];

	if (expression.startsWith("cn(")) {
		return [[...expression.matchAll(/"([^"]+)"/g)].flatMap(match => match[1]!.split(/\s+/))];
	}

	let conditional = /\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(expression);
	return conditional ? [conditional[1]!.split(/\s+/), conditional[2]!.split(/\s+/)] : [];
}

function standardButtonOffenders(source: string, file: string, action: StandardAction): string[] {
	let buttons = [...source.matchAll(/<button\b[\s\S]*?<\/button>/g)]
		.filter(button => button[0].includes(action.marker));
	if (buttons.length !== 1) {
		return [`${file}:1 ${action.action}: expected one button, found ${buttons.length}`];
	}

	let button = buttons[0]!;
	let line = source.slice(0, button.index).split("\n").length;
	let classes = classLists(button[0]);
	if (classes.length === 0) return [`${file}:${line} ${action.action}: no static class list`];

	let offenders: string[] = [];
	let tiers: string[] = [];
	for (let list of classes) {
		let sizes = list.filter(name => /^(btn-sm|btn-md|btn-icon)$/.test(name));
		let currentTiers = list.filter(name =>
			/^(btn-primary|btn-secondary|btn-ghost|btn-destructive)$/.test(name)
		);
		let legacy = list.filter(name => /^(bg|px|py)-/.test(name));
		tiers.push(...currentTiers);

		if (!list.includes("btn") || sizes.length !== 1 || sizes[0] !== action.size) {
			offenders.push(
				`${file}:${line} ${action.action}: ${list.join(" ") || "no static class list"}`,
			);
		}
		if (currentTiers.length !== 1 || legacy.length > 0) {
			offenders.push(
				`${file}:${line} ${action.action}: ${
					legacy.length > 0 ? `conflicting rest utilities ${legacy.join(" ")}` : list.join(" ")
				}`,
			);
		}
	}

	if (tiers.sort().join(" ") !== [...action.tiers].sort().join(" ")) {
		offenders.push(`${file}:${line} ${action.action}: expected ${action.tiers.join(" or ")}`);
	}
	return offenders;
}

type StandardControl = {
	file: string;
	marker: string;
	name: string;
	tag: "div" | "input" | "select" | "textarea";
	utility: "choice-control" | "field" | "field-ghost";
};

function controlBlock(source: string, control: StandardControl): string {
	let first = source.indexOf(control.marker);
	let second = source.indexOf(control.marker, first + control.marker.length);
	if (first === -1 || second !== -1) {
		throw new Error(`${control.name}: expected one marker, found ${first === -1 ? 0 : 2}`);
	}

	let start = source.lastIndexOf(`<${control.tag}`, first);
	let closing = control.tag === "select" ? "</select>" : "/>";
	let end = source.indexOf(closing, first);
	if (start === -1 || end === -1) {
		throw new Error(`${control.name}: expected a complete ${control.tag}`);
	}
	return source.slice(start, end + closing.length);
}

function controlOffenders(source: string, control: StandardControl): string[] {
	let block = controlBlock(source, control);
	let classes = /className\s*=\s*"([^"]*)"/.exec(block)?.[1]?.split(/\s+/) ?? [];
	let offenders = classes.includes(control.utility)
		? []
		: [`${control.name}: missing ${control.utility} in ${block}`];
	for (let name of classes) {
		if (/^(?:disabled|aria-disabled):opacity-.+$/.test(name)) {
			offenders.push(`${control.name}: ${name}`);
		}
	}
	return offenders;
}

describe("migration", () => {
	it("puts each listed standard control on its shared utility", () => {
		let controls: StandardControl[] = [
			{
				file: "apps/web/src/chat/chat.tsx",
				marker: 'className="field flex flex-col"',
				name: "chat composer",
				tag: "div",
				utility: "field",
			},
			{
				file: "packages/editor/src/comments.tsx",
				marker: "maxLength={limits.MAX_NOTE}",
				name: "comment composer",
				tag: "textarea",
				utility: "field",
			},
			{
				file: "packages/question/src/react/question-view.tsx",
				marker: "Type another answer",
				name: "custom questionnaire answer",
				tag: "textarea",
				utility: "field",
			},
			{
				file: "packages/question/src/react/question-view.tsx",
				marker: "checked={!custom && selected}",
				name: "questionnaire option choice",
				tag: "input",
				utility: "choice-control",
			},
			{
				file: "packages/question/src/react/question-view.tsx",
				marker: "checked={active}",
				name: "custom questionnaire choice",
				tag: "input",
				utility: "choice-control",
			},
			{
				file: "packages/editor/src/widgets/render-blocks.tsx",
				marker: 'aria-label="Code language"',
				name: "code language",
				tag: "select",
				utility: "field-ghost",
			},
		];
		let offenders = controls.flatMap(control =>
			controlOffenders(
				readFileSync(join(ROOT, control.file), "utf8"),
				control,
			)
		);
		expect(offenders).toEqual([]);
	});

	it("rejects disabled opacity only inside a listed migrated control block", () => {
		let control: StandardControl = {
			file: "fixture.tsx",
			marker: "data-migrated",
			name: "fixture field",
			tag: "textarea",
			utility: "field",
		};
		let source = `
			<textarea data-migrated className="field disabled:opacity-[.6] aria-disabled:opacity-[.4]" />
			<button className="btn disabled:opacity-50">Specialised</button>
		`;

		expect(controlOffenders(source, control)).toEqual([
			"fixture field: disabled:opacity-[.6]",
			"fixture field: aria-disabled:opacity-[.4]",
		]);
	});

	it("leaves no consumer on the replaced vocabulary", () => {
		let removed =
			/(?<![\w-])(?:text-(?:2xs|xs)|shadow-(?:xs|sm|md|lg)|(?:bg|text|border|ring)-(?:background|foreground|surface|muted(?:-foreground)?|card|popover|primary(?:-foreground|-hover)?|secondary(?:-foreground)?|accent(?:-foreground)?|border|input|ring|code))(?![\w-])|var\(--color-(?:background|foreground|surface|muted(?:-foreground)?|card(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground|-hover)?|secondary(?:-foreground)?|accent(?:-foreground)?|border|input|ring|code)\)/g;
		let offenders: string[] = [];
		for (let file of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
			if (file === join(import.meta.dir, "theme.css") || file === import.meta.path) continue;
			let content = withoutComments(readFileSync(file, "utf8"));
			for (let match of content.matchAll(removed)) {
				offenders.push(
					`${relative(ROOT, file)}:${content.slice(0, match.index).split("\n").length} ${match[0]}`,
				);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("rejects legacy rest utilities alongside a standard button", () => {
		let classes = "btn btn-sm btn-primary bg-brand px-2 py-1".split(" ");
		let previousGuardWouldAccept = classes.includes("btn")
			&& classes.filter(name => /^(btn-sm|btn-md|btn-icon)$/.test(name)).length === 1
			&& classes.filter(name =>
					/^(btn-primary|btn-secondary|btn-ghost|btn-destructive)$/.test(name)
				).length === 1;

		expect(previousGuardWouldAccept).toBe(true);
		expect(standardButtonOffenders(
			'<button className="btn btn-sm btn-primary bg-brand px-2 py-1">Fixture</button>',
			"fixture.tsx",
			{ action: "fixture", marker: "Fixture", size: "btn-sm", tiers: ["btn-primary"] },
		)).toEqual(["fixture.tsx:1 fixture: conflicting rest utilities bg-brand px-2 py-1"]);
	});

	it("rejects legacy rest utilities in a separate cn class fragment", () => {
		expect(standardButtonOffenders(
			'<button className={cn("btn btn-sm btn-primary", "bg-brand px-2 py-1")}>Fixture</button>',
			"fixture.tsx",
			{ action: "fixture", marker: "Fixture", size: "btn-sm", tiers: ["btn-primary"] },
		)).toEqual(["fixture.tsx:1 fixture: conflicting rest utilities bg-brand px-2 py-1"]);
	});

	it("puts each standard action on one button size and tier", () => {
		let actions = [
			[
				"apps/web/src/workspace.tsx",
				{
					action: "pane toggle",
					marker: "aria-controls={controls}",
					size: "btn-icon",
					tiers: ["btn-ghost"],
				},
			],
			["apps/web/src/chat/transcript.tsx", {
				action: "Withdraw",
				marker: 'title="Withdraw"',
				size: "btn-icon",
				tiers: ["btn-ghost"],
			}],
			["apps/web/src/chat/chat.tsx", {
				action: "Stop Planner",
				marker: 'wire?.send("chat:abort")',
				size: "btn-icon",
				tiers: ["btn-secondary"],
			}],
			["packages/editor/src/send-action.tsx", {
				action: "shared send action",
				marker: "aria-label={label}",
				size: "btn-icon",
				tiers: ["btn-primary"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "comment submit",
				marker: "data-plan-comment-submit",
				size: "btn-sm",
				tiers: ["btn-primary"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "comment composer send",
				marker: 'className="plan-comment-send',
				size: "btn-icon",
				tiers: ["btn-primary"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "comment cancel",
				marker: "onClick={onCancel}",
				size: "btn-sm",
				tiers: ["btn-secondary"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "Ask again",
				marker: "onClick={onRetry}",
				size: "btn-sm",
				tiers: ["btn-ghost"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "comment confirmation",
				marker: "confirmation.onConfirm();",
				size: "btn-sm",
				tiers: ["btn-secondary"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "cancel comment confirmation",
				marker: "onClick={() => setConfirming(undefined)}",
				size: "btn-sm",
				tiers: ["btn-ghost"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "Dismiss comment",
				marker: 'setConfirming("dismiss")',
				size: "btn-sm",
				tiers: ["btn-ghost"],
			}],
			["packages/editor/src/comments.tsx", {
				action: "Apply feedback",
				marker: 'setConfirming("accept")',
				size: "btn-md",
				tiers: ["btn-primary"],
			}],
			["packages/editor/src/decisions.tsx", {
				action: "resolved disclosure",
				marker: "aria-expanded={history}",
				size: "btn-sm",
				tiers: ["btn-ghost"],
			}],
			["packages/question/src/react/question-view.tsx", {
				action: "Keep it",
				marker: "setConfirming(false)",
				size: "btn-sm",
				tiers: ["btn-secondary"],
			}],
			["packages/question/src/react/question-view.tsx", {
				action: "cancel confirmation",
				marker: "onClick={onCancel}",
				size: "btn-sm",
				tiers: ["btn-destructive"],
			}],
			["packages/question/src/react/question-view.tsx", {
				action: "Cancel",
				marker: "setConfirming(true)",
				size: "btn-sm",
				tiers: ["btn-secondary"],
			}],
			["packages/question/src/react/question-view.tsx", {
				action: "Submit",
				marker: "onClick={onSubmit}",
				size: "btn-sm",
				tiers: ["btn-primary"],
			}],
		] as const;
		let offenders: string[] = [];

		for (let [file, action] of actions) {
			let source = readFileSync(join(ROOT, file), "utf8");
			offenders.push(...standardButtonOffenders(source, file, action));
		}

		expect(offenders).toEqual([]);
	});
});
