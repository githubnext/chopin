/**
 * Light, Dark or System: the theme a person chose in the account menu, kept in this browser.
 *
 * `index.html` reads the same key and draws the first frame in the chosen theme before any of this
 * runs, so nothing flashes on load; `theme-choice.test.ts` holds its script to these rules. This
 * module then follows the system's scheme live for System, takes a choice made in another tab, and
 * applies a new choice at once, with no colour easing across the page.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];
export const THEME_STORAGE_KEY = "chopin:theme";

/** The ground behind the browser's own chrome (`--color-ground`), for `<meta name="theme-color">`. */
export const THEME_GROUND: Record<Theme, string> = { light: "#f4f4f1", dark: "#181714" };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** What was stored, read as a choice: anything missing or unknown is System, the default. */
export function storedThemeChoice(raw: string | null | undefined): ThemeChoice {
	return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
	return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

export function readThemeChoice(storage?: Storage): ThemeChoice {
	try {
		return storedThemeChoice((storage ?? localStorage).getItem(THEME_STORAGE_KEY));
	} catch {
		// Private windows and blocked storage: System, as for anybody who never chose.
		return "system";
	}
}

export function keepThemeChoice(choice: ThemeChoice, storage?: Storage): void {
	try {
		(storage ?? localStorage).setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// Not kept; it holds until the page is closed.
	}
}

type Root = {
	dataset: DOMStringMap;
	classList: { toggle(name: string, force?: boolean): boolean };
	style: { colorScheme: string };
};
type Meta = { content: string } | null;

/** The one place a theme is written to the page, as `index.html` writes the first. */
export function applyTheme(
	theme: Theme,
	root: Root,
	meta: { scheme: Meta; ground: Meta },
): void {
	root.dataset.theme = theme;
	root.classList.toggle("dark", theme === "dark");
	root.style.colorScheme = theme;
	if (meta.scheme) meta.scheme.content = theme;
	if (meta.ground) meta.ground.content = THEME_GROUND[theme];
}

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

let choice: ThemeChoice = "system";
let listeners = new Set<() => void>();
let started = false;
let switching = 0;

function systemDark(): boolean {
	return typeof matchMedia === "function" && matchMedia(SYSTEM_DARK).matches;
}

function paint() {
	let theme = resolveTheme(choice, systemDark());
	let root = document.documentElement;
	if (root.dataset.theme === theme) return;
	// Every colour changes at once: a transition on each would cross-fade the whole page. The pause
	// holds for the one frame that draws the new theme, so motion after it is untouched.
	root.dataset.themeSwitching = "";
	let mine = ++switching;
	applyTheme(theme, root, {
		scheme: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]'),
		ground: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
	});
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			if (mine === switching) delete root.dataset.themeSwitching;
		})
	);
}

function emit() {
	for (let listener of listeners) listener();
}

/** Follows the system and other tabs from now on; `main.tsx` calls it once. */
export function startTheme(): void {
	if (started) return;
	started = true;
	choice = readThemeChoice();
	paint();
	if (typeof matchMedia === "function") {
		matchMedia(SYSTEM_DARK).addEventListener("change", paint);
	}
	window.addEventListener("storage", event => {
		if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
		choice = readThemeChoice();
		paint();
		emit();
	});
}

export function chooseTheme(next: ThemeChoice): void {
	choice = next;
	keepThemeChoice(next);
	paint();
	emit();
}

export function currentThemeChoice(): ThemeChoice {
	return choice;
}

export function subscribeThemeChoice(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
