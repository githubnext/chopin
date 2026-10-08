import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { validateOptionsSource } from "./openui-options";

let gallery = readFileSync(
	new URL(
		"../../../../experiments/openui-composition-trial/source-gallery-first.openui",
		import.meta.url,
	),
	"utf8",
);
let comparison = readFileSync(
	new URL(
		"../../../../experiments/openui-composition-trial/source-comparison-first.openui",
		import.meta.url,
	),
	"utf8",
);

describe("OpenUI options source boundary", () => {
	it("accepts the two arrangements of the same option records", () => {
		expect(validateOptionsSource(gallery)).toBeUndefined();
		expect(validateOptionsSource(comparison)).toBeUndefined();
		expect(gallery).toContain("[gallery, comparison, details]");
		expect(comparison).toContain("[comparison, gallery, details]");
	});

	it("rejects statements and references outside the bounded vocabulary", () => {
		expect(validateOptionsSource(gallery + 'remote = Query("https://example.com")\n'))
			.toBeDefined();
		expect(validateOptionsSource(gallery.replace("OptionGallery", "UnknownGallery")))
			.toBeDefined();
		expect(validateOptionsSource(gallery.replace(
			"[optionA, optionB, optionC]",
			"[optionA, optionA, optionC]",
		))).toBeDefined();
	});

	it("rejects oversized authored content", () => {
		expect(validateOptionsSource(gallery + "x".repeat(6000))).toBeDefined();
	});
});
