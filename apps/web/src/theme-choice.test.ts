import { describe, expect, test } from "bun:test";

import { THEME_CHOICES } from "./theme-choice";

import type { ThemeChoice } from "./theme-choice";

type Theme = "light" | "dark";

let html = await Bun.file(new URL("../index.html", import.meta.url)).text();
let theme = await Bun.file(new URL("../../../packages/visuals/theme.css", import.meta.url)).text();

const KEY = "chopin:theme";

/** The script in `index.html` that owns the theme, as the browser runs it. */
let source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
	.map(match => match[1]!)
	.find(script => script.includes(KEY));

/** Each theme's ground (`--color-gray-150`), as the theme's own comment writes it. */
function ground(css: string) {
	return /--color-gray-150:[^;]*;\s*\/\* (#[0-9a-f]{6}) \*\//.exec(css)?.[1];
}
const GROUND: Record<Theme, string | undefined> = {
	light: ground(theme),
	dark: ground(theme.slice(theme.indexOf('\n:root[data-theme="dark"] {'))),
};

/**
 * A page for the script: its root and metas, storage holding `stored` (or refusing), a system
 * scheme the test can turn, the window's events and frames, all of them observable.
 */
function page(stored: string | null | "refused", systemDark: boolean) {
	if (!source) throw new Error("index.html has no script that reads the theme");
	let held: Record<string, string> = stored === null || stored === "refused"
		? {}
		: { [KEY]: stored };
	let storage = {
		getItem: (key: string) => {
			if (stored === "refused") throw new Error("blocked");
			return held[key] ?? null;
		},
		setItem: (key: string, value: string) => {
			if (stored === "refused") throw new Error("blocked");
			held[key] = value;
		},
	};
	let classes = new Set<string>();
	let root = {
		dataset: {} as Record<string, string>,
		classList: {
			toggle(name: string, force?: boolean) {
				if (force ?? !classes.has(name)) classes.add(name);
				else classes.delete(name);
				return classes.has(name);
			},
		},
		style: { colorScheme: "" },
	};
	let metas: Record<string, { content: string }> = {
		'meta[name="color-scheme"]': { content: "light" },
		'meta[name="theme-color"]': { content: "#f4f4f1" },
	};
	let system = {
		matches: systemDark,
		listeners: [] as (() => void)[],
		addEventListener(_: string, listener: () => void) {
			this.listeners.push(listener);
		},
	};
	let listeners: Record<string, ((event: { key?: string | null }) => void)[]> = {};
	let heard: string[] = [];
	let frames: (() => void)[] = [];
	let window = {} as { chopinTheme?: (next?: ThemeChoice) => ThemeChoice };
	new Function(
		"window",
		"document",
		"localStorage",
		"matchMedia",
		"addEventListener",
		"dispatchEvent",
		"requestAnimationFrame",
		"Event",
		source,
	)(
		window,
		{ documentElement: root, querySelector: (selector: string) => metas[selector] },
		storage,
		(query: string) => {
			expect(query).toBe("(prefers-color-scheme: dark)");
			return system;
		},
		(type: string, listener: (event: { key?: string | null }) => void) => {
			(listeners[type] ??= []).push(listener);
		},
		(event: { type: string }) => heard.push(event.type),
		(frame: () => void) => frames.push(frame),
		class {
			constructor(public type: string) {}
		},
	);
	return {
		window,
		held,
		heard,
		drawn: () => ({
			theme: root.dataset.theme,
			dark: classes.has("dark"),
			colorScheme: root.style.colorScheme,
			scheme: metas['meta[name="color-scheme"]']!.content,
			ground: metas['meta[name="theme-color"]']!.content,
		}),
		switching: () => "themeSwitching" in root.dataset,
		/** Runs the frames asked for so far, and those they ask for, as the browser draws. */
		frame() {
			let now = frames.splice(0);
			for (let run of now) run();
		},
		turnSystem(dark: boolean) {
			system.matches = dark;
			for (let listener of system.listeners) listener();
		},
		storageEvent(key: string | null) {
			for (let listener of listeners.storage ?? []) listener({ key });
		},
	};
}

function painted(theme: Theme) {
	let drawn: { theme: string; dark: boolean; colorScheme: string; scheme: string; ground: string } =
		{
			theme,
			dark: theme === "dark",
			colorScheme: theme,
			scheme: theme,
			ground: String(GROUND[theme]),
		};
	return drawn;
}

/** Anything the storage can hold, or a refusal to read it. */
const STORED = [
	null,
	"light",
	"dark",
	"system",
	"",
	"Dark",
	"purple",
	'{"theme":"dark"}',
	"refused",
];

describe("a person's theme, as index.html draws it", () => {
	test("the first frame is the stored choice, System for anything unknown, missing or unreadable", () => {
		for (let stored of STORED) {
			for (let systemDark of [false, true]) {
				let choice: ThemeChoice = stored === "light" || stored === "dark" ? stored : "system";
				let expected: Theme = choice === "system" ? (systemDark ? "dark" : "light") : choice;
				let drawn = page(stored, systemDark);
				expect([stored, systemDark, drawn.drawn(), drawn.window.chopinTheme!()])
					.toEqual([stored, systemDark, painted(expected), choice]);
				// The first frame is the theme, not a switch to it.
				expect(drawn.switching()).toBe(false);
			}
		}
	});

	test("each choice is drawn at once, kept, and told to the app", () => {
		let drawn = page(null, false);
		for (let choice of ["dark", "light", "system", "dark"] as const) {
			expect(drawn.window.chopinTheme!(choice)).toBe(choice);
			expect(drawn.drawn()).toEqual(painted(choice === "dark" ? "dark" : "light"));
			expect(drawn.held[KEY]).toBe(choice);
		}
		expect(drawn.heard).toEqual(["chopin-theme", "chopin-theme", "chopin-theme", "chopin-theme"]);
		expect(THEME_CHOICES).toEqual(["light", "dark", "system"]);
	});

	test("where storage is refused, a choice still holds for the page", () => {
		let drawn = page("refused", false);
		expect(drawn.window.chopinTheme!("dark")).toBe("dark");
		expect(drawn.window.chopinTheme!()).toBe("dark");
		expect(drawn.drawn()).toEqual(painted("dark"));
	});

	test("System follows the system's scheme while the page is open; Light and Dark hold", () => {
		let drawn = page(null, false);
		drawn.turnSystem(true);
		expect(drawn.drawn()).toEqual(painted("dark"));
		drawn.turnSystem(false);
		expect(drawn.drawn()).toEqual(painted("light"));
		for (let choice of ["light", "dark"] as const) {
			drawn.window.chopinTheme!(choice);
			drawn.turnSystem(choice === "light");
			expect(drawn.drawn()).toEqual(painted(choice));
		}
	});

	test("another tab's choice is taken at once, and nothing else in storage is", () => {
		let drawn = page(null, false);
		drawn.held[KEY] = "dark";
		drawn.storageEvent("chopin:pane:chat");
		expect(drawn.drawn()).toEqual(painted("light"));
		expect(drawn.heard).toEqual([]);
		drawn.storageEvent(KEY);
		expect(drawn.drawn()).toEqual(painted("dark"));
		expect(drawn.window.chopinTheme!()).toBe("dark");
		expect(drawn.heard).toEqual(["chopin-theme"]);
		// Storage cleared in another tab: System again.
		delete drawn.held[KEY];
		drawn.storageEvent(null);
		expect(drawn.window.chopinTheme!()).toBe("system");
	});

	test("a new theme holds transitions back for the one frame that draws it", () => {
		let drawn = page(null, false);
		drawn.window.chopinTheme!("dark");
		expect(drawn.switching()).toBe(true);
		drawn.frame();
		expect(drawn.switching()).toBe(true);
		drawn.frame();
		expect(drawn.switching()).toBe(false);
		// A second switch before the first is drawn keeps them held until the second is.
		drawn.window.chopinTheme!("light");
		drawn.frame();
		drawn.window.chopinTheme!("dark");
		drawn.frame();
		expect(drawn.switching()).toBe(true);
		drawn.frame();
		expect(drawn.switching()).toBe(false);
		// Choosing the theme already drawn changes nothing on the page.
		drawn.window.chopinTheme!("system");
		drawn.window.chopinTheme!("light");
		drawn.frame();
		drawn.frame();
		drawn.window.chopinTheme!("system");
		expect(drawn.switching()).toBe(false);
	});

	test("runs before the page's stylesheets, module and body, after the metas it sets", () => {
		let script = html.search(/<script>[^<]*chopin:theme/);
		expect(script).toBeGreaterThan(html.indexOf('<meta name="theme-color"'));
		expect(script).toBeGreaterThan(html.indexOf('<meta name="color-scheme"'));
		expect(script).toBeLessThan(html.indexOf("<body"));
		expect(script).toBeLessThan(html.indexOf('<script type="module"'));
		expect(GROUND).toEqual({ light: "#f4f4f1", dark: "#181714" });
	});
});
