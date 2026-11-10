import { expect, test } from "bun:test";

/**
 * The connection banner is drawn in two places, by the Chat composer and at the top of the
 * document, and its icon colour must say the same thing in both: neutral while a phase is only
 * under way (reconnecting, retrying), warning where dropped, success once back, danger for a failure.
 * The composer's own rule for its strip is the warning colour, so a plain banner phase there has to
 * be given the neutral one explicitly.
 */
let composer = await Bun.file(new URL("./composer.css", import.meta.url)).text();
let document = await Bun.file(new URL("../document-banner.css", import.meta.url)).text();

function iconRules(css: string): { selector: string; role: string }[] {
	let source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) => {
		let role = /--color-icon:\s*var\(--color-([a-z]+)-icon\)/.exec(body!)?.[1];
		let text = selector!.replace(/\s+/g, " ").trim();
		return role && text.endsWith(".composer-notice-icon") ? [{ selector: text, role }] : [];
	});
}

test("a banner phase that is only under way has the neutral icon in the composer's strip", () => {
	let neutral = iconRules(composer).filter(rule =>
		rule.role === "neutral" && rule.selector.includes("[data-banner]")
	);
	expect(neutral).toHaveLength(1);
	for (let phase of ["data-warning", "data-success", "data-error"]) {
		expect(neutral[0]!.selector).toContain(`[${phase}]`);
	}
	expect(neutral[0]!.selector).toContain(":not(");
});

test("the document's banner gives the same phases the same icon roles", () => {
	let roles = (css: string) => new Set(iconRules(css).map(rule => rule.role));
	expect(roles(document)).toEqual(new Set(["neutral", "warning", "success"]));
	expect(roles(composer)).toEqual(new Set(["warning", "success", "neutral"]));
});
