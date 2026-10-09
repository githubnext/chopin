import { createHash } from "node:crypto";

import { parseFragment } from "parse5";
import postcss from "postcss";

import { extractJavaScript, presentation } from "./javascript";

export type Declaration = {
	property: string;
	value: string;
	line: number;
	context: string;
	dynamic?: boolean;
	foundation?: boolean;
};

export type Extraction = {
	sourceHash?: string;
	declarations: Declaration[];
	classes: { value: string; line: number; context?: string; dynamic?: boolean }[];
	errors: string[];
};

function cssUnescape(value: string): string {
	return value.replace(/\\([\da-f]{1,6}\s?|[^\r\n\f])/gi, (_, escape: string) => {
		let hex = escape.trim();
		if (/^[\da-f]{1,6}$/i.test(hex)) {
			let point = Number.parseInt(hex, 16);
			return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
		}
		return escape;
	});
}

function cssAncestors(current: postcss.AnyNode): string[] {
	let ancestors: string[] = [];
	let parent: postcss.Container | postcss.Document | undefined = current.parent;
	while (parent) {
		if ("selector" in parent) ancestors.unshift(String(parent.selector));
		if ("name" in parent && "params" in parent) {
			ancestors.unshift(`@${parent.name} ${parent.params}`.trim());
		}
		parent = parent.parent;
	}
	return ancestors;
}

export function extractSource(
	file: string,
	content: string,
	staticImport?: (specifier: string, name: string) => Record<string, string> | undefined,
): Extraction {
	let result: Extraction = {
		declarations: [],
		classes: [],
		errors: [],
		sourceHash: createHash("sha256").update(content).digest("hex"),
	};
	let addCss = (css: string, line = 1, context = "CSS") => {
		try {
			let root = postcss.parse(css, { from: file });
			root.walkDecls(declaration => {
				result.declarations.push({
					property: declaration.prop.startsWith("--")
						? cssUnescape(declaration.prop)
						: cssUnescape(declaration.prop).toLowerCase(),
					value: cssUnescape(declaration.value),
					line: line + (declaration.source?.start?.line ?? 1) - 1,
					context: [context, ...cssAncestors(declaration)].join(" > "),
				});
			});
			root.walkAtRules("apply", rule => {
				result.classes.push({
					value: cssUnescape(rule.params),
					line: line + (rule.source?.start?.line ?? 1) - 1,
					context: [context, ...cssAncestors(rule)].join(" > "),
				});
			});
		} catch (error) {
			result.errors.push(`${file}:${line} ${context} parse error: ${String(error)}`);
		}
	};

	let addJavaScript = (source: string, baseLine = 1) =>
		extractJavaScript(file, source, baseLine, result, addCss, staticImport);

	if (/\.css$/i.test(file)) addCss(content);
	else if (/\.(?:html|svg)$/i.test(file)) {
		let document = parseFragment(content, {
			sourceCodeLocationInfo: true,
			onParseError: error =>
				result.errors.push(`${file}:${error.startLine} HTML parse error: ${error.code}`),
		});
		let visit = (element: typeof document | (typeof document.childNodes)[number]) => {
			if ("attrs" in element) {
				for (let attribute of element.attrs) {
					let line = element.sourceCodeLocation?.attrs?.[attribute.name]?.startLine ?? 1;
					if (attribute.name === "style") addCss(attribute.value, line, "style attribute");
					else if (attribute.name === "class") {
						result.classes.push({
							value: attribute.value,
							line,
							context: `HTML > <${element.tagName}>`,
						});
					} else if (presentation.has(attribute.name)) {
						result.declarations.push({
							property: attribute.name,
							value: attribute.value,
							line,
							context: "presentation attribute",
						});
					}
				}
				if (element.tagName === "style" || element.tagName === "script") {
					for (let child of element.childNodes) {
						if (!("value" in child)) continue;
						let line = child.sourceCodeLocation?.startLine ?? 1;
						if (element.tagName === "style") addCss(child.value, line, "style element");
						else if (
							!element.attrs.some(attribute =>
								attribute.name === "type"
								&& !/^(?:module|(?:application|text)\/(?:java|type)script)$/.test(attribute.value)
							)
						) addJavaScript(child.value, line);
					}
				}
			}
			if ("childNodes" in element) { for (let child of element.childNodes) visit(child); }
		};
		visit(document);
	} else addJavaScript(content);
	return result;
}
