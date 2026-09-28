import { describe, expect, it } from "bun:test";

import { classProblems } from "./classes";
import { declarationProblem, type TokenPolicy } from "./policy";
import { applyExceptions, type Finding } from "./scan";

let canonical = new Map(Object.entries({
	"--text-xs": "clamp(1rem, 2vw, 2rem)",
	"--text-sm": "clamp(1rem, 2vw, 2rem)",
	"--text-2xl": "clamp(1rem, 2vw, 2rem)",
	"--font-sans": "Inter",
	"--font-mono": "monospace",
	"--text-sm--line-height": "1.5",
	"--color-brand": "oklch(.5 .1 200)",
	"--color-page": "white",
	"--radius-md": ".375rem",
	"--shadow-resting": "0 1px 2px black",
	"--duration-fast": "120ms",
	"--ease-out": "cubic-bezier(.2,0,0,1)",
	"--spacing": ".25rem",
}));
let policy: TokenPolicy = { canonical, aliases: new Map([["--plan-body", ["var(--text-sm)"]]]) };
let problem = (property: string, value: string) =>
	declarationProblem({ property, value, context: ".test", line: 1 }, policy);

describe("property-aware design policy", () => {
	it("requires each family's own role and rejects literal fallbacks and alias laundering", () => {
		for (
			let [property, value] of [
				["font-size", "14px"],
				["font-size", "var(--spacing)"],
				["font-size", "var(--text-sm, 14px)"],
				["font", "500 14px Inter"],
				["font-family", "Arial"],
				["color", "red"],
				["color", "#fff"],
				["background", "rgb(0 0 0 / 9%)"],
				["border", "1px solid blue"],
				["fill", "hsl(0 0% 0%)"],
				["border-radius", "6px"],
				["box-shadow", "0 1px 3px black"],
				["text-shadow", "0 0 1px red"],
				["transition", "opacity 200ms ease"],
				["animation", "spin 1s linear infinite"],
				["animation-timing-function", "cubic-bezier(.2,0,0,1)"],
				["transition-delay", "-100ms"],
			]
		) expect(problem(property!, value!), `${property}: ${value}`).toBeDefined();
		let aliases = new Map([["--tiny", ["14px"]], ["--loop", ["var(--loop)"]]]);
		for (let name of aliases.keys()) {
			expect(
				declarationProblem({ property: "font-size", value: `var(${name})`, context: "", line: 1 }, {
					canonical,
					aliases,
				}),
			).toBeDefined();
		}
	});

	it("accepts roles, semantic aliases, geometry, zero and property-specific neutral values", () => {
		for (
			let [property, value] of [
				["font-size", "var(--plan-body)"],
				["font-family", "var(--font-mono)"],
				["font", "500 var(--text-sm) / var(--text-sm--line-height) var(--font-sans)"],
				["color", "inherit"],
				["fill", "none"],
				["border", "1px solid var(--color-brand)"],
				["background", "color-mix(in srgb, var(--color-brand) 30%, transparent)"],
				["border-radius", "50%"],
				["border-radius", "0 var(--radius-md) var(--radius-md) 0"],
				["box-shadow", "none"],
				["box-shadow", "var(--shadow-resting)"],
				["transition", "opacity var(--duration-fast) var(--ease-out)"],
				["animation-duration", "0s"],
				["animation-timing-function", "linear"],
				["width", "42px"],
				["padding", "12px"],
			]
		) expect(problem(property!, value!), `${property}: ${value}`).toBeUndefined();
	});

	it("rejects dynamic enforced styles but permits dynamic geometry", () => {
		expect(
			declarationProblem(
				{ property: "color", value: "color", dynamic: true, context: "", line: 1 },
				policy,
			),
		).toBeDefined();
		expect(
			declarationProblem(
				{ property: "left", value: "x", dynamic: true, context: "", line: 1 },
				policy,
			),
		).toBeUndefined();
	});

	it("checks Tailwind variants, arbitrary properties, values and CSS variable shorthand", () => {
		for (
			let value of [
				"hover:text-[14px]",
				"md:rounded-[7px]",
				"bg-[#fff]",
				"[color:red]",
				"[&:hover]:duration-[200ms]",
				"text-3xl",
				"ease-in",
				"animate-[spin_1s_ease-in]",
				"-delay-100",
				"text-(length:--oops)",
			]
		) {
			expect(classProblems(value, policy), value).toHaveLength(1);
		}
		for (
			let value of [
				"text-sm",
				"hover:bg-brand/10",
				"rounded-md",
				"shadow-resting",
				"duration-fast",
				"ease-out",
				"font-medium",
				"font-mono",
				"text-[color:var(--color-brand)]",
				"text-(length:--text-sm)",
				"[border-radius:var(--radius-md)]",
				"w-[42px]",
				"border-2",
			]
		) {
			expect(classProblems(value, policy), value).toEqual([]);
		}
	});

	it("requires exact explained counted exceptions and rejects stale or parse exceptions", () => {
		let finding: Finding = {
			file: "sample.css",
			line: 2,
			family: "radius",
			property: "border-radius",
			value: "1px",
			context: ".caret",
			reason: "literal",
		};
		let exception = {
			...finding,
			count: 1,
			reason: "Caret geometry preserves the thin insertion marker.",
		};
		expect(applyExceptions([finding], [exception])).toEqual([]);
		expect(applyExceptions([finding, finding], [exception])).toHaveLength(1);
		expect(applyExceptions([], [exception])).toHaveLength(1);
		expect(applyExceptions([{ ...finding, context: ".button" }], [exception])).toHaveLength(2);
		expect(applyExceptions([], [{ ...exception, family: "parse" }]).length).toBeGreaterThan(0);
	});
});
