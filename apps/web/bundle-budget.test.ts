import { describe, expect, it } from "bun:test";

import { enforceInitialJavaScript, initialJavaScript } from "./bundle-budget";

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
