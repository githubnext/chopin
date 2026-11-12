import { expect, test } from "bun:test";

/**
 * The offline bar and the composer's failure strip must give each phase one icon colour: neutral
 * while a phase is only under way (reconnecting, retrying), warning where the connection is dropped,
 * danger for a failure. The composer's own rule for its strip is the warning colour, so a plain
 * strip phase there has to be given the neutral one explicitly.
 */
let composer = await Bun.file(new URL("./composer.css", import.meta.url)).text();
let bar = await Bun.file(new URL("./connection-state.css", import.meta.url)).text();

function iconRules(css: string, icon: string): { selector: string; role: string }[] {
	let source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) => {
		let role = /--color-icon:\s*var\(--color-([a-z]+)-icon\)/.exec(body!)?.[1];
		let text = selector!.replace(/\s+/g, " ").trim();
		return role && text.endsWith(icon) ? [{ selector: text, role }] : [];
	});
}

test("a strip phase that is only under way has the neutral icon in the composer's strip", () => {
	let neutral = iconRules(composer, ".composer-notice-icon").filter(rule =>
		rule.role === "neutral" && rule.selector.includes("[data-banner]")
	);
	expect(neutral).toHaveLength(1);
	for (let phase of ["data-warning", "data-error"]) {
		expect(neutral[0]!.selector).toContain(`[${phase}]`);
	}
	expect(neutral[0]!.selector).toContain(":not(");
});

test("the offline bar is neutral while it reconnects and the warning role once it is offline", () => {
	let rules = iconRules(bar, ".offline-bar-icon");
	expect(rules).toEqual([
		{ selector: ".offline-bar-icon", role: "neutral" },
		{ selector: ".offline-bar[data-warning] .offline-bar-icon", role: "warning" },
	]);
});
