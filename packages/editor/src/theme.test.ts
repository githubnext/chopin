import { describe, expect, it } from "bun:test";

import { readTheme, THEME_ATTRIBUTE, watchTheme } from "./theme";

/** An `<html>` and the one observer watching it, enough to drive `watchTheme` without a DOM. */
function page(initial: string | null) {
	let attributes = new Map<string, string>();
	if (initial !== null) attributes.set(THEME_ATTRIBUTE, initial);
	let watching: { callback: () => void; filter?: string[] } | undefined;
	let root = { getAttribute: (name: string) => attributes.get(name) ?? null };
	class Watcher {
		constructor(private callback: () => void) {}
		observe(_target: unknown, options: MutationObserverInit) {
			watching = { callback: this.callback, filter: options.attributeFilter };
		}
		disconnect() {
			watching = undefined;
		}
	}
	return {
		root,
		Watcher,
		get watching() {
			return watching;
		},
		set(value: string | null) {
			if (value === null) attributes.delete(THEME_ATTRIBUTE);
			else attributes.set(THEME_ATTRIBUTE, value);
			// A mutation record is delivered for every write, the same value included.
			watching?.callback();
		},
	};
}

describe("the page's theme", () => {
	it("is dark only when the page says dark", () => {
		expect(readTheme(page("dark").root)).toBe("dark");
		expect(readTheme(page("light").root)).toBe("light");
		expect(readTheme(page(null).root)).toBe("light");
		expect(readTheme(page("system").root)).toBe("light");
		expect(readTheme(page("Dark").root)).toBe("light");
	});

	it("is told once for each change of the resolved theme, and never after it stops", () => {
		let fake = page("light");
		let seen: string[] = [];
		let stop = watchTheme(theme => seen.push(theme), fake.root, fake.Watcher);
		expect(fake.watching?.filter).toEqual([THEME_ATTRIBUTE]);
		fake.set("light");
		fake.set("dark");
		fake.set("dark");
		fake.set(null);
		fake.set("garbage");
		fake.set("dark");
		expect(seen).toEqual(["dark", "light", "dark"]);
		stop();
		expect(fake.watching).toBeUndefined();
		fake.set("light");
		expect(seen).toEqual(["dark", "light", "dark"]);
	});
});
