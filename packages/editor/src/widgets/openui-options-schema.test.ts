import { describe, expect, it } from "bun:test";

import { openUIOptionsLibrary, parseOptionsSource } from "./openui-options-schema";

const PANDAS = String
	.raw`root = OptionsSection("Excel header styling", "Compare the current output with a proposed plain default.", [gallery, comparison, details])
gallery = OptionGallery("Outputs", "grid", [option1, option2])
comparison = OptionComparison("Tradeoffs", [option1, option2])
details = OptionDetails("Source reasoning", [option1, option2])
option1 = DesignOption("current", "Keep current default", "Preserves styled headers", "Basic exports retain formatting", "The issue shows bold and bordered headers in the current output.", "Current", media1)
media1 = OptionImage("https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png", "Spreadsheet with styled row and column headers", "Current output shown in pandas issue #54154")
option2 = DesignOption("plain", "Plain default", "Would produce unstyled basic exports", "Changes existing default output", "The issue proposes removing default header styling and using Styler for deliberate formatting.", "Proposal", media2)
media2 = OptionPreview("A  B\n1  2", "Illustrative reconstruction; not a source screenshot")`;

const PAGINATION = String
	.raw`root = OptionsSection("Pagination choices", "Illustrative API alternatives.", [comparison, details, gallery])
gallery = OptionGallery("Response shapes", "rail", [option2, option1, option3])
comparison = OptionComparison("Tradeoffs", [option1, option2, option3])
details = OptionDetails("How each works", [option1, option2, option3])
option1 = DesignOption("offset", "Offset", "Simple page numbers", "Deep pages can be costly", "A client sends an offset and limit.", "Simple", media1)
media1 = OptionPreview("GET /items?offset=20&limit=10", "Synthetic request")
option2 = DesignOption("cursor", "Cursor", "Stable continuation", "Opaque navigation", "A client sends the cursor from the prior response.", "Stable", media2)
media2 = OptionPreview("GET /items?after=eyJpZCI6MjB9", "Synthetic request")
option3 = DesignOption("keyset", "Keyset", "Efficient ordered scan", "Needs a stable sort key", "A client sends the last sort key it observed.", "Stable", media3)
media3 = OptionPreview("GET /items?after_id=20", "Synthetic request")`;

function error(source: string): string {
	let result = parseOptionsSource(source);
	expect("error" in result).toBe(true);
	return "error" in result ? result.error : "";
}

describe("OpenUI options composition", () => {
	it("exposes the bounded component graph in its generated OpenUI schema", () => {
		let definitions = openUIOptionsLibrary.toJSONSchema().$defs;
		expect(definitions?.OptionsSection).toMatchObject({
			properties: {
				views: {
					items: {
						anyOf: [
							{ $ref: "#/$defs/OptionGallery" },
							{ $ref: "#/$defs/OptionComparison" },
							{ $ref: "#/$defs/OptionDetails" },
						],
					},
				},
			},
		});
		for (let view of ["OptionGallery", "OptionComparison", "OptionDetails"]) {
			expect(definitions?.[view]).toMatchObject({
				properties: { options: { items: { $ref: "#/$defs/DesignOption" } } },
			});
		}
		expect(definitions?.DesignOption).toMatchObject({
			properties: {
				media: {
					anyOf: [
						{ $ref: "#/$defs/OptionImage" },
						{ $ref: "#/$defs/OptionPreview" },
					],
				},
			},
		});
	});

	it("normalizes the exact pandas example, including the image and preview", () => {
		let result = parseOptionsSource(PANDAS);
		expect("section" in result).toBe(true);
		if (!("section" in result)) return;
		expect(result.section.title).toBe("Excel header styling");
		expect(result.section.views.map(view => view.kind)).toEqual([
			"gallery",
			"comparison",
			"details",
		]);
		expect(result.section.views[0]?.options.map(option => option.id)).toEqual([
			"current",
			"plain",
		]);
		expect(result.section.views[0]?.options[0]?.media).toEqual({
			kind: "image",
			url:
				"https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png",
			alt: "Spreadsheet with styled row and column headers",
			caption: "Current output shown in pandas issue #54154",
		});
		expect(result.section.views[0]?.options[1]?.media).toEqual({
			kind: "preview",
			text: "A  B\n1  2",
			caption: "Illustrative reconstruction; not a source screenshot",
		});
	});

	it("normalizes the exact comparison-first example and independent option order", () => {
		let result = parseOptionsSource(PAGINATION);
		expect("section" in result).toBe(true);
		if (!("section" in result)) return;
		expect(result.section.views.map(view => view.kind)).toEqual([
			"comparison",
			"details",
			"gallery",
		]);
		expect(result.section.views[2]?.layout).toBe("rail");
		expect(result.section.views[2]?.options.map(option => option.id)).toEqual([
			"cursor",
			"offset",
			"keyset",
		]);
	});

	it("accepts declarations in any order and two through six options", () => {
		let reversed = PAGINATION.split("\n").toReversed().join("\n");
		expect(parseOptionsSource(reversed)).toHaveProperty("section");
		let six = PANDAS.replaceAll(
			"[option1, option2]",
			"[option1, option2, option3, option4, option5, option6]",
		)
			+ "\n"
			+ [3, 4, 5, 6].map(index =>
				`option${index} = DesignOption("extra-${index}", "Extra ${index}", "Strength", "Tradeoff", "Detail", "Other", media${index})\nmedia${index} = OptionPreview("Preview", "Example")`
			).join("\n");
		expect(parseOptionsSource(six)).toHaveProperty("section");
	});

	it("rejects missing, duplicate, and mismatched references", () => {
		expect(error(PANDAS.replace("[option1, option2]", "[option1, option3]"))).toMatch(/reference/i);
		expect(error(PANDAS.replace("[option1, option2]", "[option1, option1]"))).toMatch(/reference/i);
		expect(error(PANDAS.replace("media1)", "media2)"))).toMatch(/matching media/i);
		expect(error(PANDAS.replace("media2 = OptionPreview", "media1 = OptionPreview"))).toMatch(
			/duplicate/i,
		);
		expect(error(PANDAS.replace('"plain", "Plain default"', '"current", "Plain default"'))).toMatch(
			/duplicate/i,
		);
	});

	it("rejects unsupported components, declarations, and runtime statements", () => {
		expect(error(PANDAS.replace("OptionGallery(", "Button("))).toMatch(/unsupported/i);
		expect(error(`${PANDAS}\nother = OptionPreview("x", "y")`)).toMatch(/unsupported/i);
		expect(error(`${PANDAS}\n$state = State("x")`)).toMatch(/unsupported/i);
		expect(error(`${PANDAS}\nquery = Query("fetch")`)).toMatch(/unsupported/i);
		expect(error(`${PANDAS}\n@Set("x")`)).toMatch(/unsupported/i);
		expect(error(PANDAS.replace('"Current", media1)', '"Current", Query("x"))'))).toMatch(
			/unsupported/i,
		);
	});

	it("rejects unsafe image URLs and bounded fields", () => {
		expect(error(PANDAS.replace("https://user-images", "http://user-images"))).toMatch(
			/image URL/i,
		);
		expect(error(PANDAS.replace("https://user-images", "https://ex\\u200bample.com/user-images")))
			.toMatch(/image URL/i);
		expect(
			error(
				PANDAS.replace(
					'"current", "Keep current default"',
					`"${"x".repeat(25)}", "Keep current default"`,
				),
			),
		).toMatch(/field/i);
		expect(error(PANDAS.replace('"Keep current default"', '""'))).toMatch(/field/i);
		expect(error(PANDAS.replace('"Current"', `"${"x".repeat(33)}"`))).toMatch(/field/i);
		for (
			let [original, length] of [
				["Excel header styling", 91],
				["Compare the current output with a proposed plain default.", 241],
				["Keep current default", 71],
				["Preserves styled headers", 181],
				["Basic exports retain formatting", 181],
				["The issue shows bold and bordered headers in the current output.", 501],
				["Spreadsheet with styled row and column headers", 181],
				["Current output shown in pandas issue #54154", 101],
				["A  B\\n1  2", 241],
			] as const
		) {
			expect(error(PANDAS.replace(original, "x".repeat(length)))).toMatch(/field/i);
		}
		expect(error(PANDAS.replace('"grid"', '"stack"'))).toMatch(/field|parse/i);
	});

	it("rejects absent or oversized source and physical multiline strings", () => {
		expect(error("")).toMatch(/source/i);
		expect(error("x".repeat(12_001))).toMatch(/source/i);
		expect(error(PANDAS.replace("A  B\\n1  2", "A  B\n1  2"))).toMatch(/statement|parse/i);
	});
});
