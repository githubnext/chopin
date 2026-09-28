import { describe, expect, it } from "bun:test";

import { typeScaleProblems } from "./check-type-scale";

describe("fluid type scale lint", () => {
	it("accepts named roles and inherited inline code", () => {
		let css = `
			.prose { font-size: var(--text-base); }
			.control { font: 500 var(--text-sm) / var(--text-sm--line-height) Inter; }
			.code { font-size: inherit; }
			.editor { font-size: var(--plan-body); }
		`;
		let markup = `<h1 className="text-2xl" style={{ fontSize: "var(--text-2xl)" }} />
			<text font-size="var(--text-xs)" fontSize={"var(--text-sm)"} />`;
		expect(typeScaleProblems("sample.css", css)).toEqual([]);
		expect(typeScaleProblems("sample.tsx", markup)).toEqual([]);
		expect(
			typeScaleProblems("sample.ts", 'element.style.setProperty("font-size", "var(--text-sm)")'),
		)
			.toEqual([]);
	});

	it("rejects literal and off-ramp sizes in every supported syntax", () => {
		let cases = [
			["sample.css", ".label { font-size: 14.5px }"],
			["sample.css", ".label { font-size: var(--label-size); }"],
			["sample.css", ".code { font-size: 0.875em; }"],
			["sample.css", ".label { font: 14.5px Inter; }"],
			["sample.css", ".label { font: 14.5px var(--text-sm) Inter; }"],
			["sample.tsx", "<p style={{ fontSize: 14.5 }} />"],
			["sample.tsx", '<p style={{ fontSize: "14.5px" }} />'],
			["sample.tsx", '<p className="text-[14.5px]" />'],
			["sample.tsx", '<p className="text-(length:--label-size)" />'],
			["sample.tsx", '<p className="text-3xl" />'],
			["sample.tsx", 'element.style.setProperty("font-size", "14.5px")'],
			["sample.svg", '<text font-size="14.5px">Label</text>'],
			["sample.html", '<p style="font-size: 14.5px;">Label</p>'],
			["sample.ts", 'let css = ".label { font-size: 14.5px; }";'],
			["sample.css", ":root { --text-tiny: 14.5px; }"],
		] as const;
		for (let [file, source] of cases) {
			expect(typeScaleProblems(file, source)).toHaveLength(1);
		}
	});

	it("permits the audited scale specimen but rejects the same dynamic style elsewhere", () => {
		let source = "style={{ fontSize: `var(${size})` }}";
		expect(typeScaleProblems("apps/web/src/design-audit/foundations.tsx", source)).toEqual([]);
		expect(typeScaleProblems("apps/web/src/other.tsx", source)).toHaveLength(1);
	});

	it("does not flag examples in comments", () => {
		expect(typeScaleProblems("sample.tsx", "// fontSize: 14.5\n/* font-size: 14.5px; */"))
			.toEqual([]);
	});
});
