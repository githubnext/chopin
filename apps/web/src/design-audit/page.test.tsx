import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesignAuditPage } from "./page";

describe("design audit page", () => {
	it("identifies itself as a development inspection surface", () => {
		let markup = renderToStaticMarkup(createElement(DesignAuditPage));

		expect(markup).toContain('data-design-audit=""');
		expect(markup).toContain("Chopin design audit");
	});
});
