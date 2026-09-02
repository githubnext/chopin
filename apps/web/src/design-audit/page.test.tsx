import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesignAuditPage } from "./page";

describe("design audit page", () => {
	it("identifies itself as a development inspection surface", () => {
		let markup = renderToStaticMarkup(createElement(DesignAuditPage));

		expect(markup).toContain('data-design-audit=""');
		expect(markup).toContain("Chopin design audit");
		expect(markup).toContain('aria-label="Design audit sections"');
		expect(markup).toContain('aria-label="Preview wide layout"');
		expect(markup).toContain('aria-label="Preview narrow layout"');
		expect(markup).toContain('data-preview-width="wide"');
		for (let id of ["foundations", "controls", "surfaces", "authored-content"]) {
			expect(markup).toContain(`id="${id}"`);
		}
	});
});
