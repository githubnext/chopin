import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticPlanEditor } from "./static-plan-editor";

describe("StaticPlanEditor", () => {
	it("provides a labelled read-only document without collaboration chrome", () => {
		let source =
			'# Audit fixture\n\n<Callout type="note">\n\nInspect this.\n\n</Callout>\n\n```ts\nlet checked = true;\n```\n';
		let markup = renderToStaticMarkup(createElement(StaticPlanEditor, { source }));

		expect(markup).toContain('aria-label="Authored content specimen"');
		expect(markup).toContain('data-source-length="');
		expect(markup).toContain('data-read-only="true"');
		expect(markup).not.toContain("Not connected");
		expect(markup).not.toContain("plan-status");
	});
});
