import { describe, expect, it } from "bun:test";

import {
	enforceInitialJavaScript,
	enforceInitialStylesheet,
	initialJavaScript,
	initialStylesheet,
} from "./bundle-budget";

describe("the initial JavaScript budget", () => {
	it("measures the static entry graph without charging for a selected channel", () => {
		let measured = initialJavaScript({
			"entry.js": {
				code: "entry",
				dynamicImports: ["workspace.js"],
				fileName: "entry.js",
				imports: ["shared.js"],
				isEntry: true,
				type: "chunk",
			},
			"shared.js": {
				code: "shared",
				dynamicImports: [],
				fileName: "shared.js",
				imports: [],
				isEntry: false,
				type: "chunk",
			},
			"workspace.js": {
				code: "workspace",
				dynamicImports: [],
				fileName: "workspace.js",
				imports: [],
				isEntry: false,
				type: "chunk",
			},
		});

		expect(measured).toEqual({ files: ["entry.js", "shared.js"], gzip: 51, raw: 11 });
	});

	it("rejects a build when either initial limit is crossed", () => {
		expect(() =>
			enforceInitialJavaScript(
				{ files: ["entry.js"], gzip: 101, raw: 351 },
				{ gzip: 110, raw: 350 },
			)
		).toThrow(
			"initial JavaScript 351 B raw / 101 B gzip exceeds budget 350 B raw / 110 B gzip",
		);
	});
});

describe("the initial stylesheet budget", () => {
	it("measures the static entry graph's stylesheets without charging for lazy chunks", () => {
		let measured = initialStylesheet({
			"entry.js": {
				code: "entry",
				dynamicImports: ["workspace.js"],
				fileName: "entry.js",
				imports: ["shared.js"],
				isEntry: true,
				type: "chunk",
				viteMetadata: { importedCss: new Set(["entry.css", "shared.css"]) },
			},
			"shared.js": {
				code: "shared",
				dynamicImports: [],
				fileName: "shared.js",
				imports: [],
				isEntry: false,
				type: "chunk",
				viteMetadata: { importedCss: new Set(["shared.css"]) },
			},
			"workspace.js": {
				code: "workspace",
				dynamicImports: [],
				fileName: "workspace.js",
				imports: [],
				isEntry: false,
				type: "chunk",
				viteMetadata: { importedCss: new Set(["assistant-ui.css"]) },
			},
			"entry.css": {
				fileName: "entry.css",
				source: "body{}",
				type: "asset",
			},
			"shared.css": {
				fileName: "shared.css",
				source: new TextEncoder().encode("a{}"),
				type: "asset",
			},
			"assistant-ui.css": {
				fileName: "assistant-ui.css",
				source: "[data-slot]{}",
				type: "asset",
			},
		});

		expect(measured).toEqual({ files: ["entry.css", "shared.css"], gzip: 49, raw: 9 });
	});

	it("rejects a bundle without an initial stylesheet or with a missing asset", () => {
		expect(() =>
			initialStylesheet({
				"entry.js": {
					code: "entry",
					dynamicImports: [],
					fileName: "entry.js",
					imports: [],
					isEntry: true,
					type: "chunk",
				},
			})
		).toThrow("expected at least one initial stylesheet, found 0");

		expect(() =>
			initialStylesheet({
				"entry.js": {
					code: "entry",
					dynamicImports: [],
					fileName: "entry.js",
					imports: [],
					isEntry: true,
					type: "chunk",
					viteMetadata: { importedCss: new Set(["missing.css"]) },
				},
			})
		).toThrow("initial stylesheet imports missing asset missing.css");
	});

	it("rejects a build when either initial stylesheet limit is crossed", () => {
		expect(() =>
			enforceInitialStylesheet(
				{ files: ["entry.css"], gzip: 111, raw: 340 },
				{ gzip: 110, raw: 350 },
			)
		).toThrow(
			"initial stylesheet 340 B raw / 111 B gzip exceeds budget 350 B raw / 110 B gzip",
		);
	});
});
