import postcss from "postcss";
import { parseDocument } from "yaml";

let colors: Record<string, string> = {
	petrol: "brand",
	"petrol-hover": "brand-hover",
	"petrol-active": "brand-active",
	page: "page",
	ground: "ground",
	inset: "inset",
	selected: "selected",
	ink: "text-primary",
	"secondary-ink": "text-secondary",
	"tertiary-ink": "text-tertiary",
	destructive: "destructive",
	success: "success",
	warning: "warning",
	merged: "merged-icon",
	"chat-divider": "chat-divider",
};
let typography: Record<string, string> = {
	"document-title": "2xl",
	"section-heading": "xl",
	subheading: "lg",
	"document-body": "base",
	chrome: "sm",
	compact: "xs",
	"small-metadata": "2xs",
};
let spacing: Record<string, number> = {
	half: 0.5,
	base: 1,
	"one-and-half": 1.5,
	two: 2,
	three: 3,
	four: 4,
	six: 6,
	eight: 8,
};
let shadows = ["resting", "resting-strong", "raised", "overlay"];
let motion: Record<string, string> = {
	fast: "--duration-fast",
	base: "--duration-base",
	linger: "--duration-linger",
	"smooth-out": "--motion-smooth-out",
	move: "--motion-move",
	"sidebar-open": "--sidebar-open-dur",
	"sidebar-close": "--sidebar-close-dur",
};

type ObjectRecord = Record<string, unknown>;

function object(value: unknown, path: string): ObjectRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path}: expected an object`);
	}
	return value as ObjectRecord;
}

function keys(value: ObjectRecord, expected: string[], path: string) {
	for (let key of expected) {
		if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: missing mapped field`);
	}
	for (let key of Object.keys(value)) {
		if (!expected.includes(key)) throw new Error(`${path}.${key}: unknown mapped field`);
	}
}

function scalar(value: unknown, path: string): string {
	if (typeof value !== "string" && typeof value !== "number") {
		throw new Error(`${path}: expected a string or number`);
	}
	return String(value);
}

function normalize(value: string): string {
	return value.trim().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1");
}

/** Check the deliberately mapped subset; prose and illustrative recipes remain human-reviewed. */
export function designRecordProblems(
	theme: string,
	markdown: string,
	json: string,
	context: { web: string; editor: string },
): string[] {
	let problems: string[] = [];
	try {
		let match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
		if (!match) throw new Error("DESIGN.md: missing YAML frontmatter");
		let yaml = parseDocument(match[1], { uniqueKeys: true });
		if (yaml.errors.length) throw new Error(`DESIGN.md: ${yaml.errors[0].message}`);
		let record = object(yaml.toJS(), "DESIGN.md");
		let sidecar = object(JSON.parse(json), "design.json");
		if (sidecar.schemaVersion !== 2) throw new Error("design.json: expected schemaVersion 2");
		let extensions = object(sidecar.extensions, "design.json.extensions");
		let contextual = (source: string, selector: string, property: string): string => {
			let values: string[] = [];
			postcss.parse(source).walkRules(selector, rule => {
				rule.walkDecls(property, declaration => {
					values.push(declaration.value);
				});
			});
			if (values.length !== 1) {
				throw new Error(`${selector} ${property}: expected exactly one contextual declaration`);
			}
			return values[0];
		};
		let divider = contextual(context.web, ".workspace-frame .workspace-chat-panel", "border-color");
		let proseLeading = contextual(context.editor, ".plan .plan-content", "line-height");
		let tokens = new Map<string, string>();
		postcss.parse(theme).walkAtRules("theme", rule => {
			rule.walkDecls(declaration => {
				let name = declaration.prop;
				if (!name.startsWith("--")) return;
				if (name.endsWith("-*") && declaration.value === "initial") {
					for (let token of tokens.keys()) {
						if (token.startsWith(name.slice(0, -1))) tokens.delete(token);
					}
				} else tokens.set(name, declaration.value);
			});
		});
		let resolveCSS = (value: string, trail: string[] = []): string => {
			return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
				if (trail.includes(name)) {
					throw new Error(`theme: alias cycle ${[...trail, name].join(" → ")}`);
				}
				let token = tokens.get(name);
				if (token === undefined) throw new Error(`theme: unknown token ${name}`);
				return resolveCSS(token, [...trail, name]);
			});
		};
		let resolveRecord = (value: unknown, trail: string[] = []): string => {
			let text = scalar(value, trail.at(-1) ?? "record");
			return text.replace(/\{([\w.-]+)\}/g, (_, path: string) => {
				if (trail.includes(path)) {
					throw new Error(`DESIGN.md: alias cycle ${[...trail, path].join(" → ")}`);
				}
				let field: unknown = record;
				for (let segment of path.split(".")) field = object(field, path)[segment];
				if (field === undefined) throw new Error(`DESIGN.md: unknown alias {${path}}`);
				return resolveRecord(field, [...trail, path]);
			});
		};
		let compare = (path: string, value: unknown, expected: string, font = false) => {
			let actual = resolveCSS(resolveRecord(value));
			let wanted = resolveCSS(expected);
			// Quotes do not change the identity of these simple font family names.
			if (font) {
				actual = actual.replace(/["']/g, "");
				wanted = wanted.replace(/["']/g, "");
			}
			if (normalize(actual) !== normalize(wanted)) {
				problems.push(
					`${path}: ${JSON.stringify(actual)} disagrees with ${JSON.stringify(wanted)}`,
				);
			}
		};
		for (
			let [group, mapping] of Object.entries({
				colors,
				rounded: {
					sm: "sm",
					md: "md",
					lg: "lg",
					xl: "xl",
					full: "full",
				},
			})
		) {
			let fields = object(record[group], `DESIGN.md.${group}`);
			keys(fields, Object.keys(mapping), `DESIGN.md.${group}`);
			for (let [name, token] of Object.entries(mapping)) {
				compare(
					`DESIGN.md.${group}.${name}`,
					fields[name],
					name === "chat-divider"
						? divider
						: `var(--${group === "colors" ? "color" : "radius"}-${token})`,
				);
			}
		}
		let roles = object(record.typography, "DESIGN.md.typography");
		keys(roles, Object.keys(typography), "DESIGN.md.typography");
		for (let [name, token] of Object.entries(typography)) {
			let role = object(roles[name], `DESIGN.md.typography.${name}`);
			keys(
				role,
				["fontFamily", "fontSize", "fontWeight", "lineHeight"],
				`DESIGN.md.typography.${name}`,
			);
			let font = ["document-title", "section-heading", "subheading"].includes(name)
				? "--font-document-heading"
				: "--font-sans";
			compare(`DESIGN.md.typography.${name}.fontFamily`, role.fontFamily, `var(${font})`, true);
			compare(`DESIGN.md.typography.${name}.fontSize`, role.fontSize, `var(--text-${token})`);
			compare(
				`DESIGN.md.typography.${name}.lineHeight`,
				role.lineHeight,
				name === "document-body" ? proseLeading : `var(--text-${token}--line-height)`,
			);
			if (typeof role.fontWeight !== "number" || role.fontWeight < 1 || role.fontWeight > 1000) {
				throw new Error(`DESIGN.md.typography.${name}.fontWeight: expected weight from 1 to 1000`);
			}
			if (font === "--font-document-heading") {
				compare(
					`DESIGN.md.typography.${name}.fontWeight`,
					role.fontWeight,
					"var(--font-weight-document-heading)",
				);
			}
		}
		let steps = object(record.spacing, "DESIGN.md.spacing");
		keys(steps, Object.keys(spacing), "DESIGN.md.spacing");
		let unit = /^([\d.]+)(rem|px)$/.exec(resolveCSS("var(--spacing)"));
		if (!unit) throw new Error("theme: --spacing must be a rem or px length");
		for (let [name, multiplier] of Object.entries(spacing)) {
			compare(
				`DESIGN.md.spacing.${name}`,
				steps[name],
				`${Number(unit[1]) * multiplier}${unit[2]}`,
			);
		}
		let colorMeta = object(extensions.colorMeta, "design.json.extensions.colorMeta");
		keys(colorMeta, Object.keys(colors), "design.json.extensions.colorMeta");
		for (let [name, token] of Object.entries(colors)) {
			let color = object(colorMeta[name], `design.json.extensions.colorMeta.${name}`);
			compare(
				`design.json.extensions.colorMeta.${name}.canonical`,
				color.canonical,
				name === "chat-divider" ? divider : `var(--color-${token})`,
			);
		}
		keys(
			object(extensions.typographyMeta, "design.json.extensions.typographyMeta"),
			Object.keys(typography),
			"design.json.extensions.typographyMeta",
		);
		for (
			let [group, mapping] of Object.entries({
				shadows: Object.fromEntries(shadows.map(name => [name, `--shadow-${name}`])),
				motion,
			})
		) {
			let entries = extensions[group];
			if (!Array.isArray(entries)) {
				throw new Error(`design.json.extensions.${group}: expected an array`);
			}
			let byName: ObjectRecord = {};
			for (let entry of entries) {
				let field = object(entry, `design.json.extensions.${group}`);
				let name = scalar(field.name, `${group}.name`);
				if (Object.hasOwn(byName, name)) {
					throw new Error(`${group}.${name}: duplicate mapped field`);
				}
				byName[name] = field.value;
			}
			keys(byName, Object.keys(mapping), `design.json.extensions.${group}`);
			for (let [name, token] of Object.entries(mapping)) {
				compare(`design.json.extensions.${group}.${name}`, byName[name], `var(${token})`);
			}
		}
		let walk = (value: unknown) => {
			if (typeof value === "string") resolveCSS(resolveRecord(value));
			else if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === "object") Object.values(value).forEach(walk);
		};
		walk(record.components);
	} catch (error) {
		problems.push(error instanceof Error ? error.message : String(error));
	}
	return problems;
}
