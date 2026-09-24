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
});
