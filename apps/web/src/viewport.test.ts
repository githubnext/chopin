import { describe, expect, it } from "bun:test";

import { viewportVars } from "./viewport";

describe("viewport variables", () => {
	it("uses the visible viewport and reports the covered keyboard area", () => {
		expect(viewportVars(844, { height: 506, top: 0 })).toEqual({
			"--app-left": "0px",
			"--app-height": "506px",
			"--app-top": "0px",
			"--app-width": "100%",
			"--keyboard-inset": "338px",
		});
	});

	it("accounts for a visual viewport offset", () => {
		expect(viewportVars(844, { height: 506, top: 22 })).toEqual({
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

	it("keeps the layout viewport while pinch zoomed", () => {
		expect(
			viewportVars(900, { height: 450, left: 300, top: 200, width: 720 }, 2),
		)
			.toEqual({
				"--app-left": "0px",
				"--app-height": "900px",
				"--app-top": "0px",
				"--app-width": "100%",
				"--keyboard-inset": "0px",
			});
	});

	it("follows a keyboard-shifted viewport at unit scale", () => {
		expect(viewportVars(844, { height: 506, left: 12, top: 22, width: 320 }, 1))
			.toEqual({
				"--app-left": "12px",
				"--app-height": "506px",
				"--app-top": "22px",
				"--app-width": "320px",
				"--keyboard-inset": "316px",
			});
	});
});
