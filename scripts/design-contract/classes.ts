import { declarationProblem, type TokenPolicy } from "./policy";

/** Split variants only outside arbitrary values, e.g. [&:hover]:text-[color:var(...)]. */
function utility(value: string): string {
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "[" || value[i] === "(") depth++;
		if (value[i] === "]" || value[i] === ")") depth--;
		if (value[i] === ":" && depth === 0) start = i + 1;
	}
	return value.slice(start).replace(/^!|!$/g, "");
}

export function classProblems(value: string, policy: TokenPolicy): string[] {
	let problems: string[] = [];
	for (let raw of value.split(/\s+/)) {
		let name = utility(raw).replace(/^-delay-/, "delay-");
		if (policy.utilities?.has(name)) continue;
		let arbitrary = /^\[([\w-]+):(.+)\]$/.exec(name);
		if (arbitrary) {
			let declaration = {
				property: arbitrary[1]!,
				value: arbitrary[2]!.replaceAll("_", " "),
				line: 1,
				context: raw,
			};
			if (declarationProblem(declaration, policy)) problems.push(raw);
			continue;
		}
		let match =
			/^(text|font|bg|from|via|to|divide|ring-offset|border(?:-[xytrblse])?|outline|ring|decoration|fill|stroke|rounded(?:-[trblse]{1,2})?|shadow|inset-shadow|drop-shadow|duration|delay|ease|animate)-(.+)$/
				.exec(name);
		if (!match) continue;
		let prefix = match[1]!;
		let tail = match[2]!;
		let level = 0;
		let cut = tail.length;
		for (let i = 0; i < tail.length; i++) {
			if ("[(".includes(tail[i]!)) level++;
			if (")]".includes(tail[i]!)) level--;
			if (tail[i] === "/" && level === 0) {
				cut = i;
				break;
			}
		}
		tail = tail.slice(0, cut);
		let base = tail;
		let property = prefix === "text"
			? "color"
			: prefix === "font"
			? "font-family"
			: prefix.startsWith("rounded")
			? "border-radius"
			: prefix.endsWith("shadow")
			? "box-shadow"
			: prefix === "animate"
			? "animation"
			: prefix === "duration" || prefix === "delay"
			? `transition-${prefix}`
			: prefix === "ease"
			? "transition-timing-function"
			: "color";
		if (prefix === "text" && /^(xs|sm|base|lg|xl|2xl)$/.test(base)) continue;
		if (
			prefix === "text"
			&& /^(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(
				base,
			)
		) continue;
		if (
			prefix === "font"
			&& /^(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|stretch-.+)$/.test(
				base,
			)
		) continue;
		if (
			/^(border|outline|ring|stroke)/.test(prefix)
			&& /^(\d+(\.\d+)?|none|solid|dashed|dotted|double|hidden|inset|offset-.+)$/.test(base)
		) continue;
		if (
			prefix === "bg"
			&& /^(none|auto|cover|contain|center|top|bottom|left|right|fixed|local|scroll|clip-.+|origin-.+|repeat.*|no-repeat|size-.+|position-.+)$/
				.test(base)
		) continue;
		if (
			prefix === "decoration" && /^(auto|from-font|\d+|solid|double|dotted|dashed|wavy)$/.test(base)
		) continue;
		if (/^[[(]/.test(tail)) {
			let expression = tail.slice(1, -1).replaceAll("_", " ");
			if (expression.startsWith("length:") || expression.startsWith("size:")) {
				if (prefix === "text") property = "font-size";
				expression = expression.slice(expression.indexOf(":") + 1);
			} else expression = expression.replace(/^color:/, "");
			if (tail.startsWith("(")) expression = `var(${expression})`;
			if (prefix === "text" && (expression.startsWith("var(--text-") || /^\d/.test(expression))) {
				property = "font-size";
			}
			if (declarationProblem({ property, value: expression, line: 1, context: raw }, policy)) {
				problems.push(raw);
			}
			continue;
		}
		let token = prefix === "font"
			? `--font-${base}`
			: prefix.startsWith("rounded")
			? `--radius-${base}`
			: prefix.endsWith("shadow")
			? `--shadow-${base}`
			: prefix === "animate"
			? `--animate-${base}`
			: prefix === "duration" || prefix === "delay"
			? `--duration-${base}`
			: prefix === "ease"
			? `--ease-${base}`
			: `--color-${base}`;
		if (base === "none" && /^(rounded|shadow)/.test(prefix)) continue;
		if (base === "full" && prefix.startsWith("rounded")) continue;
		if (prefix === "animate" && base === "none") continue;
		if (base === "linear" && prefix === "ease") continue;
		if (!policy.canonical.has(token)) problems.push(raw);
	}
	return [...new Set(problems)];
}
