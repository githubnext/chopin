import { expect, test } from "bun:test";

let semanticCss = await Bun.file(new URL("./semantic-tone.css", import.meta.url)).text();
let iconLabelCss = await Bun.file(new URL("./icon-label.css", import.meta.url)).text();

function declarations(selector: string) {
	let escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let match = semanticCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `missing rule for ${selector}`).not.toBeNull();
	return match?.[1] ?? "";
}

test("maps every semantic tone to the exact component-facing aliases", () => {
	let selectors = {
		neutral: ".cv-semantic",
		success: '.cv-semantic[data-tone="success"]',
		warning: '.cv-semantic[data-tone="warning"]',
		danger: '.cv-semantic[data-tone="danger"]',
	} as const;

	for (let [tone, selector] of Object.entries(selectors)) {
		let rule = declarations(selector);
		for (let role of ["surface", "icon", "text"]) {
			expect(rule).toContain(
				`--cv-semantic-${role}: var(--color-${tone}-${role});`,
			);
		}
	}
	expect(semanticCss).not.toContain("--cv-semantic-graphic");
});

test("keeps IconLabel compact, truncatable, and token-backed", () => {
	let css = `${semanticCss}\n${iconLabelCss}`;

	expect(iconLabelCss).toContain("font-size: var(--text-sm);");
	expect(iconLabelCss).toContain("line-height: var(--text-sm--line-height);");
	expect(iconLabelCss).toContain("min-width: 0;");
	expect(iconLabelCss).toContain("max-width: 100%;");
	expect(iconLabelCss).toContain("overflow: hidden;");
	expect(iconLabelCss).toContain("text-overflow: ellipsis;");
	expect(iconLabelCss).toContain("background: var(--cv-semantic-surface);");
	expect(iconLabelCss).toContain("color: var(--cv-semantic-icon);");
	expect(iconLabelCss).toContain("color: var(--cv-semantic-text);");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
	expect(css).not.toContain(".cv-badge");
});
