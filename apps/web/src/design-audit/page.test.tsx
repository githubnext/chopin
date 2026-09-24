import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AUDIT_INVENTORY } from "./inventory";
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

	it("documents one shared foundation with only the audit field Select adopted", () => {
		let markup = renderToStaticMarkup(createElement(DesignAuditPage));
		let adoptedControls = markup.match(
			/<ul aria-label="Adopted shared controls">([\s\S]*?)<\/ul>/,
		)?.[1] ?? "";

		expect(markup).toContain("One foundation, gradual adoption");
		expect(adoptedControls.match(/<li/g)).toHaveLength(1);
		expect(adoptedControls).toContain("Select");
		expect(adoptedControls).toContain("Design audit field only");
	});

	it("records adoption provenance and post-PR11 state in the inventory", () => {
		expect(AUDIT_INVENTORY.map(group => group.id)).toEqual([
			"foundations",
			"controls",
			"surfaces",
			"authored-content",
		]);
		expect(
			AUDIT_INVENTORY.flatMap(group => group.items).find(item => item.id === "shared-adoption"),
		).toEqual({
			id: "shared-adoption",
			label: "One foundation, gradual adoption",
			source: "apps/web/src/design-audit/adoption.tsx",
			states: ["shared-foundation", "audit-field-select"],
		});
	});
});
