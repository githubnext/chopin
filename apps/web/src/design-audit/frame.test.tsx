import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuditPlate, StateLabel } from "./frame";

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
});
