import { extractSource } from "./source";

export const DIAGRAM_TYPOGRAPHY_SOURCE = "packages/diagrams/src/core/tokens.mjs";

/** A canvas foundation is checked as data; its module is never executed by validation. */
export function diagramTypographyFoundation(source: string) {
	let variables: Record<string, string> = {};
	let properties = new Map<string, "font-size" | "font-family">();
	let errors: string[] = [];
	let extract = (expression: string) => {
		let result = extractSource(
			DIAGRAM_TYPOGRAPHY_SOURCE,
			`${source}\n<div style={${expression}} />;`,
		);
		errors.push(...result.errors);
		let values: Record<string, string> = {};
		for (let declaration of result.declarations) {
			if (declaration.dynamic || declaration.property === "*") {
				errors.push(`Diagram typography foundation must be static: ${declaration.value}`);
			} else values[declaration.property] = declaration.value;
		}
		return values;
	};
	let declared = extract("diagramTypographyVariables");
	for (let name of ["label", "sub", "tag", "edge"]) {
		let role = extract(`{ ...DIAGRAM_TYPE.${name},
			"--role-transform": DIAGRAM_TYPE.${name}.upper ? "uppercase" : "none",
			"--role-family": DIAGRAM_TYPE.${name}.mono ? "mono" : "sans" }`);
		let size = Number(role.size);
		let lineHeight = Number(role["line-height"]);
		if (!(size > 0 && size <= 64 && lineHeight >= size && lineHeight <= 96)) {
			errors.push(`Invalid diagram typography metrics for ${name}`);
		}
		if (
			![400, 500, 600, 700].includes(Number(role.weight))
			|| !/^var\(--font-(sans|mono)\)$/.test(role["font-family"] ?? "")
			|| role["font-family"] !== `var(--font-${role["--role-family"]})`
			|| !(Number(role.tracking) >= 0 && Number(role.tracking) <= 0.3)
		) errors.push(`Invalid diagram typography role for ${name}`);
		let expected: Record<string, string> = {
			"font-size": `${role.size}px`,
			"line-height": `${role["line-height"]}px`,
			"font-weight": role.weight!,
			"font-family": role["font-family"]!,
			tracking: `${role.tracking}em`,
			"text-transform": role["--role-transform"]!,
		};
		for (let [field, value] of Object.entries(expected)) {
			let token = `--diagram-${name}-${field}`;
			if (declared[token] !== value) errors.push(`Diagram typography token drift: ${token}`);
			variables[token] = value;
			if (field === "font-size" || field === "font-family") properties.set(token, field);
		}
	}
	if (Object.keys(declared).some(name => !(name in variables))) {
		errors.push("Diagram typography foundation exports an unrelated styling property");
	}
	return { variables, properties, errors };
}
