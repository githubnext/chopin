/**
 * Light, Dark or System: the theme a person chose in the account menu, kept in this browser.
 *
 * `index.html` owns it: its first script reads the choice, draws the first frame in it, follows the
 * system's scheme for System and other tabs' choices, and answers `chopinTheme` (`theme-choice.test.ts`
 * runs that script). This module is the app's handle on it, so none of that is in the bundle twice.
 */

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

declare global {
	interface Window {
		/** Answers the choice, after making `next` the choice and drawing it when one is given. */
		chopinTheme?: (next?: ThemeChoice) => ThemeChoice;
	}
}

export function currentThemeChoice(): ThemeChoice {
	return window.chopinTheme?.() ?? "system";
}

export function chooseTheme(next: ThemeChoice): void {
	window.chopinTheme?.(next);
}

/** Told whenever the choice changes, here or in another tab. */
export function subscribeThemeChoice(listener: () => void): () => void {
	addEventListener("chopin-theme", listener);
	return () => removeEventListener("chopin-theme", listener);
}
