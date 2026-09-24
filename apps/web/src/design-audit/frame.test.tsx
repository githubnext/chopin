import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuditPlate, StateLabel } from "./frame";
import { AUDIT_INVENTORY } from "./inventory";
import { DesignAuditPage } from "./page";

function plate(markup: string, item: string): string {
	let start = markup.indexOf(`<section class="design-audit-plate" data-audit-item="${item}">`);
	let end = markup.indexOf("</section>", start);
	return start === -1 || end === -1 ? "" : markup.slice(start, end + "</section>".length);
}

describe("design audit specimen framing", () => {
	it("labels a specimen and its represented state", () => {
		let markup = renderToStaticMarkup(
			createElement(
				AuditPlate,
				{ title: "Primary button", description: "Shared action hierarchy" },
				createElement(StateLabel, null, "Focus"),
			),
		);

		expect(markup).toContain("Primary button");
		expect(markup).toContain("Shared action hierarchy");
		expect(markup).toContain("Focus");
	});

	it("maps every assembled audit plate to its inventory source", () => {
		let markup = renderToStaticMarkup(createElement(DesignAuditPage));

		for (let group of AUDIT_INVENTORY) {
			for (let item of group.items) {
				expect(plate(markup, item.id)).toContain(
					`<code class="design-audit-source">${item.source}</code>`,
				);
			}
		}
	});

	it("places source provenance after the specimen description", () => {
		let markup = renderToStaticMarkup(
			createElement(AuditPlate, {
				description: "Shared action hierarchy",
				item: "buttons",
				title: "Primary button",
			}),
		);

		expect(markup.indexOf("Shared action hierarchy")).toBeLessThan(
			markup.indexOf("apps/web/src/theme.css"),
		);
	});

	it("styles state labels as quiet metadata rather than pills", async () => {
		let css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
		let rule = css.match(/\.design-audit-state\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(rule).toContain("color: var(--color-text-quaternary)");
		expect(rule).not.toContain("background:");
		expect(rule).not.toContain("border-radius:");
		expect(rule).not.toContain("padding-inline:");
	});
});
