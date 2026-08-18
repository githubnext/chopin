import { describe, expect, it } from "bun:test";

import { viewportVars } from "./viewport";

describe("viewport variables", () => {
	it("uses the visible viewport and reports the covered keyboard area", () => {
		expect(viewportVars(844, { height: 506, offsetTop: 0 })).toEqual({
			"--app-left": "0px",
			"--app-height": "506px",
			"--app-top": "0px",
			"--app-width": "100%",
			"--keyboard-inset": "338px",
		});
	});

	it("accounts for a visual viewport offset", () => {
		expect(viewportVars(844, { height: 506, offsetTop: 22 })).toEqual({
			"--app-left": "0px",
			"--app-height": "506px",
			"--app-top": "22px",
			"--app-width": "100%",
			"--keyboard-inset": "316px",
		});
	});

	it("falls back to the layout viewport", () => {
		expect(viewportVars(844)).toEqual({
			"--app-left": "0px",
			"--app-height": "844px",
			"--app-top": "0px",
			"--app-width": "100%",
			"--keyboard-inset": "0px",
		});
	});
});
