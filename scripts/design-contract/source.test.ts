import { describe, expect, it } from "bun:test";

import { classProblems } from "./classes";
import { extractSource } from "./source";

describe("design source extraction", () => {
	it("parses nested CSS, shorthands, escapes and Tailwind apply", () => {
		let result = extractSource(
			"sample.css",
			String.raw`
			/* font-size: 99px; */
			@layer components {
				.card {
					font: 500 var(--text-sm) / 1.5 sans-serif;
					&:hover { color: rgb(1 2 3 / 50%); }
					font\2d size: 18px;
					@apply hover:text-[19px] rounded-[7px];
				}
			}
		`,
		);
		expect(result.errors).toEqual([]);
		expect(result.declarations.map(({ property, value }) => [property, value])).toEqual([
			["font", "500 var(--text-sm) / 1.5 sans-serif"],
			["color", "rgb(1 2 3 / 50%)"],
			["font-size", "18px"],
		]);
		expect(result.classes[0]?.value).toBe("hover:text-[19px] rounded-[7px]");
		expect(result.declarations[0]?.line).toBe(5);
		expect(result.declarations[0]?.context).toBe("CSS > @layer components > .card");
		expect(result.declarations[1]?.context).toBe("CSS > @layer components > .card > &:hover");
	});

	it("extracts JSX styles with quoted, computed, shorthand and numeric properties", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let property = "borderRadius";
			let color = "#fff";
			let base = { fontSize: 18 };
			let style = { ...base, "boxShadow": "0 1px 2px #000", [property]: "4px", color } as const;
			let view = <p style={style} fontSize={"20px"} fill="red" />;
		`,
		);
		expect(result.errors).toEqual([]);
		expect(result.declarations.map(({ property, value }) => [property, value])).toEqual([
			["font-size", "18"],
			["box-shadow", "0 1px 2px #000"],
			["border-radius", "4px"],
			["color", "#fff"],
			["font-size", "20px"],
			["fill", "red"],
		]);
	});

	it("resolves static templates and concatenation in style values", () => {
		let result = extractSource(
			"sample.tsx",
			'let role = "--text-sm"; let view = <p style={{ fontSize: `var(${role})`, color: "var(" + "--ink)" }} />;',
		);
		expect(result.declarations.map(({ value }) => value)).toEqual(["var(--text-sm)", "var(--ink)"]);
		expect(result.declarations.every(declaration => !declaration.dynamic)).toBe(true);
	});

	it("extracts both conditional style and value branches", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let view = <p style={active ? { fontSize: active ? "16px" : "18px" } : { color: "red" }} />;
			let other = <p style={active && { transitionDuration: "0s" }} />;
		`,
		);
		expect(result.declarations.map(({ value }) => value)).toEqual(["16px", "18px", "red", "0s"]);
	});

	it("does not confuse shadowed identifiers or reassigned bindings with constants", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let color = "var(--ink)";
			function paint(color: string) { return <p style={{ color }} />; }
			let size = "var(--text-sm)";
			size = getSize();
			let view = <p style={{ fontSize: size }} />;
		`,
		);
		expect(result.declarations).toHaveLength(2);
		expect(result.declarations.every(declaration => declaration.dynamic)).toBe(true);
	});

	it("marks unresolved properties, computed keys, bindings and spreads", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let view = <p style={{ ...external, fontSize: getSize(), [key]: "red" }} />;
			let other = <p style={externalStyle} />;
		`,
		);
		expect(result.declarations.map(({ property }) => property)).toEqual([
			"*",
			"font-size",
			"*",
			"*",
		]);
		expect(result.declarations.filter(declaration => declaration.dynamic)).toHaveLength(4);
	});

	it("extracts DOM writes including aliases, bracket notation, cssText and Object.assign", () => {
		let result = extractSource(
			"sample.ts",
			`
			let style = element.style;
			style["fontSize"] = "18px";
			element["style"].setProperty("border-radius", "7px");
			element.style.cssText = "color: red; box-shadow: 0 0 2px black";
			Object.assign(element.style, { transitionDuration: "100ms" });
			element.setAttribute("style", "font-size: 19px");
			element.setAttribute("fill", "blue");
			let setStyle = element.style.setProperty;
			setStyle("font-size", "21px");
		`,
		);
		expect(result.errors).toEqual([]);
		expect(result.declarations.map(({ property }) => property)).toEqual([
			"font-size",
			"border-radius",
			"color",
			"box-shadow",
			"transition-duration",
			"font-size",
			"fill",
			"font-size",
		]);
	});

	it("extracts styles and classes from JSX prop spreads and createElement props", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let props = { style: { color: "red" }, className: "text-3xl" };
			let view = <p {...props} {...(active ? { id: "a" } : { id: "b" })} />;
			let other = <p {...externalProps} />;
			React.createElement("p", { style: { fontSize: "18px" } });
		`,
		);
		expect(result.declarations.map(({ property }) => property)).toEqual([
			"color",
			"*",
			"font-size",
		]);
		expect(result.classes.map(({ value }) => value)).toEqual(["text-3xl"]);
		expect(result.declarations[1]?.dynamic).toBe(true);
	});

	it("resolves static object members but marks mutation as a dynamic boundary", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let tokens = { size: "18px" };
			let first = <p style={{ fontSize: tokens.size }} />;
			let styles = { color: "red" };
			styles.color = getColor();
			let second = <p style={styles} />;
			let third = { fontSize: "16px" };
			Object.assign(third, extra);
			let last = <p style={third} />;
		`,
		);
		expect(result.declarations[0]?.value).toBe("18px");
		expect(
			result.declarations.filter(declaration =>
				declaration.context.startsWith("mutated style object")
			),
		).toHaveLength(2);
	});

	it("marks mutated class maps and JSX prop objects as dynamic boundaries", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let choices = {};
			choices["bg-red-500"] = true;
			let view = <div className={clsx(choices)} />;
			let props = { style: { color: "var(--color-brand)" } };
			Object.assign(props, { style: { color: "red" } });
			let other = <div {...props} />;
		`,
		);
		expect(result.classes).toContainEqual({
			value: "choices",
			line: 4,
			context: "mutated class object > view > <div>",
			dynamic: true,
		});
		expect(result.declarations).toContainEqual({
			property: "*",
			value: "props",
			line: 7,
			context: "mutated JSX props > other > <div>",
			dynamic: true,
		});
	});

	it("checks every finite local class-map choice and keeps opaque maps dynamic", () => {
		let result = extractSource(
			"sample.tsx",
			`
			import { imported } from "./external";
			let tones = { quiet: "text-sm", loud: "text-[9px]" } as const;
			let view = <div className={tones[tone]} />;
			let changed = { quiet: "text-sm" };
			changed.loud = getClass();
			let other = <div className={changed[tone]} />;
			let remote = <div className={imported[tone]} />;
			let spread = { ...imported, quiet: "text-sm" };
			let opaque = <div className={spread[tone]} />;
		`,
		);
		expect(result.classes.filter(entry => !entry.dynamic).map(({ value }) => value)).toEqual([
			"text-sm",
			"text-[9px]",
		]);
		expect(result.classes.filter(entry => entry.dynamic).map(({ value }) => value)).toEqual([
			"changed[tone]",
			"imported[tone]",
			"spread[tone]",
		]);
		let policy = { canonical: new Map<string, string>(), aliases: new Map<string, string[]>() };
		expect(result.classes.flatMap(entry => classProblems(entry.value, policy))).toContain(
			"text-[9px]",
		);
	});

	it("marks dynamic setAttribute names even when the value is static", () => {
		let result = extractSource(
			"sample.ts",
			`
			el.setAttribute(getName(), getValue());
			el.setAttribute(name, "red");
			el.setAttribute("aria-label", getLabel());
		`,
		);
		expect(result.declarations).toEqual([
			{
				property: "*",
				value: "getValue()",
				line: 2,
				context: "DOM dynamic attribute > el.setAttribute(getName())",
				dynamic: true,
			},
			{
				property: "*",
				value: "red",
				line: 3,
				context: "DOM dynamic attribute > el.setAttribute(name)",
				dynamic: true,
			},
		]);
	});

	it("extracts class values from the Lexical theme without treating keys as classes", () => {
		let result = extractSource(
			"sample.ts",
			`
			let PLAN_LEXICAL_THEME = { paragraph: "text-3xl", text: { bold: "font-bold" }, ...lexicalTheme };
		`,
		);
		expect(result.classes.map(({ value }) => value)).toEqual(["text-3xl", "font-bold"]);
	});

	it("checks exported class constants at their producer while ignoring prose", () => {
		let result = extractSource(
			"sample.ts",
			`
			export const CELL = "font-medium text-[9px]";
			export let rowClass = ["rounded-[4px]", "duration-[300ms]"];
			let SHELL = { regular: "bg-red-500", empty: "shadow-xl" };
			export { SHELL };
			export const PROMPT = "Use text-[9px], then explain why.";
		`,
		);
		expect(result.classes.map(({ value }) => value)).toEqual([
			"font-medium text-[9px]",
			"rounded-[4px]",
			"duration-[300ms]",
			"bg-red-500",
			"shadow-xl",
		]);
	});

	it("bounds recursive dynamic values without crashing", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let value = active ? value : "18px";
			let styles = { ...styles };
			let view = <p style={{ ...styles, fontSize: value }} />;
		`,
		);
		expect(result.declarations.some(declaration => declaration.dynamic)).toBe(true);
		expect(result.declarations.some(declaration => declaration.value === "18px")).toBe(true);
	});

	it("marks dynamic DOM property names and dynamic stylesheet text", () => {
		let result = extractSource(
			"sample.ts",
			`
			element.style[key] = value;
			element.style.setProperty(name, value);
			element.style.cssText = getStyles();
		`,
		);
		expect(result.declarations).toHaveLength(3);
		expect(
			result.declarations.every(declaration => declaration.property === "*" && declaration.dynamic),
		).toBe(true);
	});

	it("extracts class lists, helpers, conditional alternatives and constant references", () => {
		let result = extractSource(
			"sample.tsx",
			`
			let oversized = "text-3xl";
			let view = <p className={clsx("text-sm", active && oversized, { "rounded-[7px]": active })} />;
			element.className = active ? "bg-red-500" : "bg-blue-500";
			element.classList.add("shadow-xl", "duration-[300ms]");
			element.classList.toggle("ease-linear", active);
		`,
		);
		expect(result.classes.map(({ value }) => value)).toEqual([
			"text-sm",
			"text-3xl",
			"rounded-[7px]",
			"bg-red-500",
			"bg-blue-500",
			"shadow-xl",
			"duration-[300ms]",
			"ease-linear",
		]);
	});

	it("keeps static class template segments and marks unresolved interpolation", () => {
		let result = extractSource(
			"sample.tsx",
			"let view = <p className={`text-3xl ${className}`} />;",
		);
		expect(result.classes).toContainEqual({
			value: "text-3xl ",
			line: 1,
			context: "class > view > <p>",
		});
		expect(result.classes).toContainEqual({
			value: "className",
			line: 1,
			context: "class > view > <p>",
			dynamic: true,
		});
	});

	it("parses recognized CSS strings and CSS tags without scanning arbitrary prose", () => {
		let result = extractSource(
			"sample.ts",
			`
			let css = ".label { font-size: 18px; }";
			let rules = cssTag;
			let styledValue = css\`.other { color: red; }\`;
			let note = "Example font-size: 999px";
			let config = { fontSize: 900, color: "red" };
			// element.style.fontSize = "800px";
			/* <p style={{ fontSize: 700 }} /> */
		`,
		);
		expect(result.errors).toEqual([]);
		expect(result.declarations.map(({ value }) => value)).toEqual(["18px", "red"]);
	});

	it("parses HTML styles, style elements, entities, SVG attributes and scripts", () => {
		let result = extractSource(
			"sample.html",
			`
			<style>.label { font-size: 18px; }</style>
			<p class="text-[19px]" style="color: &#35;fff">A</p>
			<svg><text font-size="20px" fill="red">B</text></svg>
			<script>element.style.borderRadius = "7px";</script>
			<script type="application/json">{"fontSize": "99px"}</script>
		`,
		);
		expect(result.errors).toEqual([]);
		expect(result.declarations.map(({ property, value }) => [property, value])).toEqual([
			["font-size", "18px"],
			["color", "#fff"],
			["font-size", "20px"],
			["fill", "red"],
			["border-radius", "7px"],
		]);
		expect(result.classes).toEqual([{ value: "text-[19px]", line: 3, context: "HTML > <p>" }]);
	});

	it("reports malformed CSS, JavaScript, HTML and embedded CSS", () => {
		for (
			let [file, source] of [
				["sample.css", ".label { font-size:"],
				["sample.tsx", "let view = <p style={{ fontSize: }} />"],
				["sample.html", '<p style="font-size: 18px>'],
				["sample.ts", 'element.style.cssText = "color red";'],
			]
		) expect(extractSource(file, source).errors.length).toBeGreaterThan(0);
	});
});
