import valueParser from "postcss-value-parser";

import type { Declaration } from "./source";

export type Family = "typography" | "color" | "radius" | "shadow" | "motion" | "dynamic";
export type TokenPolicy = {
	canonical: Map<string, string>;
	aliases: Map<string, string[]>;
	utilities?: Set<string>;
};

let roles = new Set(["2xs", "xs", "sm", "base", "lg", "xl", "2xl"]);
let neutral = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
let colorWords = new Set(["transparent", "currentcolor", "none"]);

export function familyOf(property: string): Family | undefined {
	if (property === "*") return "dynamic";
	if (["font", "font-size", "font-family"].includes(property)) return "typography";
	if (/^border(?:-[a-z]+)*-radius$/.test(property)) return "radius";
	if (["box-shadow", "text-shadow"].includes(property)) return "shadow";
	if (/^(animation|transition)(-(duration|delay|timing-function))?$/.test(property)) {
		return "motion";
	}
	if (
		property.endsWith("color")
		|| ["background", "background-image", "fill", "stroke"].includes(property)
		|| /^(border|outline)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(property)
	) return "color";
	return undefined;
}

function tokenFamily(name: string, family: Family, property: string): boolean {
	if (family === "typography") {
		if (property === "font-family") return name.startsWith("--font-");
		return roles.has(name.slice(7)) && name.startsWith("--text-")
			|| property === "font"
				&& (name.startsWith("--font-") || /^--text-.*--line-height$/.test(name));
	}
	if (family === "color") return name.startsWith("--color-") || name === "--focus-ring-color";
	if (family === "radius") return name.startsWith("--radius-");
	if (family === "shadow") return name.startsWith("--shadow-") && name !== "--shadow-color";
	return /^--(duration-|ease-|motion-(smooth-out|move)$)/.test(name)
		|| /-(dur|ease)$/.test(name) || /^--(acc-(expand|collapse)|toast-(open|close))$/.test(name);
}

/** Token references must lead to the right canonical role, never a local literal alias. */
function validToken(
	name: string,
	family: Family,
	property: string,
	policy: TokenPolicy,
	seen: Set<string>,
): boolean {
	if (policy.canonical.has(name)) return tokenFamily(name, family, property);
	if (seen.has(name)) return false;
	let values = policy.aliases.get(name);
	if (!values?.length) return false;
	let next = new Set(seen).add(name);
	return values.every(value => !valueProblems(property, value, family, policy, next).length);
}

function valueProblems(
	property: string,
	value: string,
	family: Family,
	policy: TokenPolicy,
	seen = new Set<string>(),
): string[] {
	if (neutral.has(value.toLowerCase()) || value === "") return [];
	let nodes = valueParser(value).nodes;
	let problems: string[] = [];
	let role = false;
	let walk = (list: typeof nodes, nested = false) => {
		for (let node of list) {
			if (node.type === "space" || node.type === "comment" || node.type === "div") continue;
			let word = node.value.toLowerCase();
			if (node.type === "function") {
				if (word === "var") {
					let name = node.nodes[0]?.value ?? "";
					let geometry = family === "color" && /^(border|outline)/.test(property)
						&& ["--edge-width", "--button-edge-width", "--focus-ring-width"].includes(name);
					if (!geometry && !validToken(name, family, property, policy, seen)) {
						problems.push(`unapproved token ${name}`);
					}
					if (validToken(name, "typography", "font-size", policy, seen)) role = true;
					let comma = node.nodes.findIndex(item => item.type === "div" && item.value === ",");
					if (comma >= 0) walk(node.nodes.slice(comma + 1), true);
				} else if (family === "color" && word === "url") {
					// Images and authored SVG assets have their own palette; they are not UI color literals.
				} else if (
					family === "color"
					&& ["color-mix", "linear-gradient", "radial-gradient", "conic-gradient"].includes(word)
				) {
					walk(node.nodes, true);
				} else if (["calc", "min", "max", "clamp"].includes(word)) {
					walk(node.nodes, true);
				} else problems.push(`literal function ${node.value}()`);
				continue;
			}
			if (family === "typography") {
				if (
					property === "font"
					&& (/^(normal|italic|oblique|bold|bolder|lighter|small-caps)$/.test(word)
						|| /^\d+(\.\d+)?$/.test(word))
				) continue;
				if (nested && ["*", "/", "+", "-", "0"].includes(word)) continue;
				problems.push(`literal ${node.value}`);
			} else if (family === "radius") {
				if (
					/^0([a-z]+|%)?$/.test(word) || word === "50%" || nested && /^[\d.+*/-]+%?$/.test(word)
				) continue;
				problems.push(`literal ${node.value}`);
			} else if (family === "shadow") {
				if (word !== "none") problems.push(`literal ${node.value}`);
			} else if (family === "motion") {
				if (/^-?(\d*\.)?\d+(ms|s)$/.test(word) && parseFloat(word) !== 0) {
					problems.push(`literal duration ${node.value}`);
				} else if (/^(ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(word)) {
					problems.push(`literal easing ${node.value}`);
				} else if (property.endsWith("timing-function") && word !== "linear") {
					problems.push(`literal easing ${node.value}`);
				} else if (/(duration|delay)$/.test(property) && !/^0(ms|s)?$/.test(word)) {
					problems.push(`literal duration ${node.value}`);
				}
			} else if (family === "color") {
				if (colorWords.has(word)) continue;
				if (
					nested
					&& /^(in|srgb|srgb-linear|oklab|oklch|hsl|longer|shorter|hue|to|top|bottom|left|right|circle|ellipse|at|center)$/
						.test(word)
				) continue;
				if (/^-?(\d*\.)?\d+(%|px|rem|em|deg|turn)?$/.test(word)) {
					if (nested || /^(border|outline|background)/.test(property) || Number(word) === 0) {
						continue;
					}
				}
				if (
					/^(border|outline)/.test(property)
					&& /^(solid|dotted|dashed|double|hidden|groove|ridge|inset|outset|thin|medium|thick)$/
						.test(word)
				) continue;
				if (
					property.startsWith("background")
					&& /^(repeat|no-repeat|cover|contain|fixed|scroll|center|top|bottom|left|right|padding-box|border-box|content-box)$/
						.test(word)
				) continue;
				problems.push(`literal color ${node.value}`);
			}
		}
	};
	walk(nodes);
	if (property === "font" && !role) problems.push("font shorthand requires a named size role");
	return problems;
}

export function declarationProblem(
	declaration: Declaration,
	policy: TokenPolicy,
): { family: Family; reason: string } | undefined {
	let { property, value, dynamic } = declaration;
	let override = policy.canonical.has(property) && !property.endsWith("-*")
		? property.startsWith("--text-") && !property.endsWith("--line-height")
			? "font-size"
			: property.startsWith("--color-")
			? "color"
			: property.startsWith("--radius-")
			? "border-radius"
			: property.startsWith("--shadow-")
			? "box-shadow"
			: property.startsWith("--font-")
			? "font-family"
			: tokenFamily(property, "motion", "transition")
			? "transition"
			: undefined
		: undefined;
	if (override) {
		let errors = valueProblems(override, value, familyOf(override)!, policy);
		if (errors.length) {
			return {
				family: familyOf(override)!,
				reason: "local override of canonical token: " + errors.join("; "),
			};
		}
	}
	let family = familyOf(property);
	if (
		property.startsWith("--text-") && !roles.has(property.slice(7))
		&& !/^--text-(2xs|xs|sm|base|lg|xl|2xl)--line-height$/.test(property)
		&& property !== "--text-*"
	) {
		return { family: "typography", reason: "custom size is outside the approved fluid scale" };
	}
	if (!family) return;
	if (dynamic || family === "dynamic") {
		return { family, reason: "dynamic style requires a reviewed exact exception" };
	}
	let problems = valueProblems(property, value, family, policy);
	if (problems.length) return { family, reason: [...new Set(problems)].join("; ") };
}
