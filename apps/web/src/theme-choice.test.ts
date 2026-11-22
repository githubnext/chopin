import { describe, expect, test } from "bun:test";

import {
	applyTheme,
	keepThemeChoice,
	readThemeChoice,
	resolveTheme,
	storedThemeChoice,
	THEME_GROUND,
	THEME_STORAGE_KEY,
} from "./theme-choice";

import type { Theme } from "./theme-choice";

let html = await Bun.file(new URL("../index.html", import.meta.url)).text();
let theme = await Bun.file(new URL("../../../packages/visuals/theme.css", import.meta.url)).text();

function storage(held: Record<string, string> = {}) {
	return {
		getItem: (key: string) => held[key] ?? null,
		setItem: (key: string, value: string) => void (held[key] = value),
	};
}

let refusing = {
	getItem: (): string | null => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

/** What anything can find in storage: nothing, each choice, a value from elsewhere, a refusal. */
let STORED: (string | null | "throws")[] = [
	null,
	"light",
	"dark",
	"system",
	"",
	"Dark",
	"purple",
	'{"theme":"dark"}',
	"throws",
];

function fakePage() {
	let classes = new Set<string>();
	let metas = {
		'meta[name="color-scheme"]': { content: "light" },
		'meta[name="theme-color"]': { content: "#f4f4f1" },
	};
	let root = {
		dataset: {} as Record<string, string>,
		classList: {
			toggle(name: string, force?: boolean) {
				let on = force ?? !classes.has(name);
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
		},
		style: { colorScheme: "" },
	};
	return {
		root,
		classes,
		metas,
		document: {
			documentElement: root,
			querySelector: (selector: keyof typeof metas) => metas[selector],
		},
		drawn: () => ({
			theme: root.dataset.theme,
			dark: classes.has("dark"),
			colorScheme: root.style.colorScheme,
			scheme: metas['meta[name="color-scheme"]'].content,
			ground: metas['meta[name="theme-color"]'].content,
		}),
	};
}

/** `index.html`'s first script that reads the theme, run as the browser runs it. */
function prePaint(stored: string | null | "throws", systemDark: boolean) {
	let source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
		.map(match => match[1]!)
		.find(script => script.includes(THEME_STORAGE_KEY));
	if (!source) throw new Error("index.html has no script that reads the theme");
	let page = fakePage();
	let localStorage = stored === "throws" ? refusing : storage(
		stored === null ? {} : { [THEME_STORAGE_KEY]: stored },
	);
	let matchMedia = (query: string) => ({
		matches: query === "(prefers-color-scheme: dark)" && systemDark,
	});
	new Function("document", "localStorage", "matchMedia", source)(
		page.document,
		localStorage,
		matchMedia,
	);
	return page.drawn();
}

function expected(theme: Theme) {
	return {
		theme,
		dark: theme === "dark",
		colorScheme: theme,
		scheme: theme,
		ground: THEME_GROUND[theme],
	};
}

describe("a person's theme", () => {
	test("is System for somebody who never chose, for anything unknown and where storage is refused", () => {
		expect(readThemeChoice(storage())).toBe("system");
		for (let raw of ["", "Dark", "purple", '{"theme":"dark"}']) {
			expect(readThemeChoice(storage({ [THEME_STORAGE_KEY]: raw }))).toBe("system");
		}
		expect(readThemeChoice(refusing)).toBe("system");
		expect(storedThemeChoice(undefined)).toBe("system");
	});

	test("is kept in this browser, and a refusal to keep it is not an error", () => {
		let held = storage();
		for (let choice of ["dark", "light", "system"] as const) {
			keepThemeChoice(choice, held);
			expect(readThemeChoice(held)).toBe(choice);
		}
		expect(() => keepThemeChoice("dark", refusing)).not.toThrow();
	});

	test("System follows the system's scheme; Light and Dark never do", () => {
		for (let systemDark of [false, true]) {
			expect(resolveTheme("system", systemDark)).toBe(systemDark ? "dark" : "light");
			expect(resolveTheme("light", systemDark)).toBe("light");
			expect(resolveTheme("dark", systemDark)).toBe("dark");
		}
	});

	test("writes every mark of a theme together: data-theme, .dark, color-scheme and both metas", () => {
		let page = fakePage();
		let meta = {
			scheme: page.metas['meta[name="color-scheme"]'],
			ground: page.metas['meta[name="theme-color"]'],
		};
		applyTheme("dark", page.root, meta);
		expect(page.drawn()).toEqual(expected("dark"));
		applyTheme("light", page.root, meta);
		expect(page.drawn()).toEqual(expected("light"));
	});

	test("index.html draws the first frame exactly as the app would, for every stored value and system scheme", () => {
		for (let stored of STORED) {
			for (let systemDark of [false, true]) {
				let choice = stored === "throws" ? readThemeChoice(refusing) : storedThemeChoice(stored);
				expect([stored, systemDark, prePaint(stored, systemDark)]).toEqual([
					stored,
					systemDark,
					expected(resolveTheme(choice, systemDark)),
				]);
			}
		}
	});

	test("index.html reads the theme before the page's stylesheets and body", () => {
		let script = html.search(/<script>[^<]*chopin:theme/);
		expect(script).toBeGreaterThan(html.indexOf('<meta name="theme-color"'));
		expect(script).toBeGreaterThan(html.indexOf('<meta name="color-scheme"'));
		expect(script).toBeLessThan(html.indexOf("<body"));
		expect(script).toBeLessThan(html.indexOf('<script type="module"'));
	});

	test("the browser's chrome takes each theme's ground", () => {
		let night = theme.slice(theme.indexOf('\n:root[data-theme="dark"] {'));
		let ground = (source: string) =>
			/--color-gray-150:[^;]*;\s*\/\* (#[0-9a-f]{6}) \*\//.exec(source)?.[1];
		expect(ground(theme)).toBe(THEME_GROUND.light);
		expect(ground(night)).toBe(THEME_GROUND.dark);
	});
});
