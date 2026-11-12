import { describe, expect, it } from "bun:test";

import { keyboardOpen, viewportVars } from "./viewport";

describe("viewport variables", () => {
	it("uses the visible viewport and reports the covered keyboard area", () => {
		expect(viewportVars(844, { height: 506, top: 0 })).toEqual({
			"--app-height": "506px",
			"--keyboard-inset": "338px",
			left: "0px",
			top: "0px",
			width: "100%",
		});
	});

	it("accounts for a visual viewport offset", () => {
		expect(viewportVars(844, { height: 506, top: 22 })).toEqual({
			"--app-height": "506px",
			"--keyboard-inset": "316px",
			left: "0px",
			top: "22px",
			width: "100%",
		});
	});

	it("falls back to the layout viewport", () => {
		expect(viewportVars(844)).toEqual({
			"--app-height": "844px",
			"--keyboard-inset": "0px",
			left: "0px",
			top: "0px",
			width: "100%",
		});
	});

	it("keeps the layout viewport while pinch zoomed", () => {
		expect(
			viewportVars(900, { height: 450, left: 300, top: 200, width: 720 }, 2),
		)
			.toEqual({
				"--app-height": "900px",
				"--keyboard-inset": "0px",
				left: "0px",
				top: "0px",
				width: "100%",
			});
	});

	it("follows a keyboard-shifted viewport at unit scale", () => {
		expect(viewportVars(844, { height: 506, left: 12, top: 22, width: 320 }, 1))
			.toEqual({
				"--app-height": "506px",
				"--keyboard-inset": "316px",
				left: "12px",
				top: "22px",
				width: "320px",
			});
	});

	it("treats only a keyboard-sized cover as an open keyboard", () => {
		expect(keyboardOpen(viewportVars(844, { height: 506, top: 22 }, 1))).toBe(true);
		expect(keyboardOpen(viewportVars(844, { height: 790, top: 0 }, 1))).toBe(false);
	});
});
