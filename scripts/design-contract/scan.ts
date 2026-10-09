import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import postcss from "postcss";

import { classProblems } from "./classes";
import { DIAGRAM_TYPOGRAPHY_SOURCE, diagramTypographyFoundation } from "./diagram-typography";
import { declarationProblem, type TokenPolicy } from "./policy";
import { type Extraction, extractSource } from "./source";

export type Finding = {
	dynamic?: boolean;
	sourceHash?: string;
	file: string;
	line: number;
	family: string;
	property: string;
	value: string;
	context: string;
	reason: string;
};
export type Exception = Omit<Finding, "line" | "reason"> & { count: number; reason: string };

export function sourceFiles(root: string): string[] {
	let visit = (dir: string): string[] =>
		readdirSync(dir).flatMap(entry => {
			if (entry.startsWith(".") || ["node_modules", "dist"].includes(entry)) return [];
			let path = join(dir, entry);
			if (statSync(path).isDirectory()) return visit(path);
			if (/\.(test|spec|e2e)\.[jt]sx?$/.test(entry)) return [];
			return /\.(css|html|svg|[jt]sx?)$/.test(entry) ? [path] : [];
		});
	return ["apps", "packages"].flatMap(dir => visit(join(root, dir)));
}

export function inspect(file: string, extracted: Extraction, policy: TokenPolicy): Finding[] {
	let findings: Finding[] = extracted.errors.map(reason => ({
		file,
		line: 1,
		family: "parse",
		property: "",
		value: "",
		context: "",
		reason,
	}));
	for (let declaration of extracted.declarations) {
		let problem = declarationProblem(declaration, policy);
		if (problem) {
			findings.push({
				file,
				...declaration,
				...problem,
				...(declaration.dynamic ? { sourceHash: extracted.sourceHash } : {}),
			});
		}
	}
	for (let item of extracted.classes) {
		if (item.dynamic) {
			findings.push({
				file,
				line: item.line,
				family: "dynamic",
				dynamic: true,
				sourceHash: extracted.sourceHash,
				property: "class",
				value: item.value,
				context: item.context ?? "class",
				reason: "dynamic utility requires a reviewed exact exception",
			});
			continue;
		}
		for (let value of classProblems(item.value, policy)) {
			findings.push({
				file,
				line: item.line,
				family: "utility",
				property: "class",
				value,
				context: item.context ?? "class",
				reason: "utility bypasses canonical roles",
			});
		}
	}
	return findings;
}

export function scan(
	root: string,
	read = (path: string) => readFileSync(path, "utf8"),
): { findings: Finding[]; files: number; policy: TokenPolicy } {
	let files = sourceFiles(root);
	let contents = files.map(path => ({ file: relative(root, path), content: read(path) }));
	let foundationPath = join(root, DIAGRAM_TYPOGRAPHY_SOURCE);
	if (
		existsSync(foundationPath)
		&& !contents.some(source => source.file === DIAGRAM_TYPOGRAPHY_SOURCE)
	) {
		contents.push({ file: DIAGRAM_TYPOGRAPHY_SOURCE, content: read(foundationPath) });
	}
	let catalog = contents.find(source => source.file === DIAGRAM_TYPOGRAPHY_SOURCE);
	let foundation = catalog && diagramTypographyFoundation(catalog.content);
	let sources = contents.map(({ file, content }) => {
		return {
			file,
			content,
			extracted: extractSource(
				file,
				content,
				(specifier, name) =>
					name === "diagramTypographyVariables"
						&& normalize(join(dirname(file), specifier)) === DIAGRAM_TYPOGRAPHY_SOURCE
						&& !foundation?.errors.length
						? foundation?.variables
						: undefined,
			),
		};
	});
	let canonical = new Map<string, string>();
	for (let [name, value] of Object.entries(foundation?.variables ?? {})) canonical.set(name, value);
	let aliases = new Map<string, string[]>();
	for (let { file, extracted } of sources) {
		for (let { property, value, context } of extracted.declarations) {
			if (!property.startsWith("--")) continue;
			if (file === "packages/visuals/theme.css" && /^CSS > @theme(?: static)?$/.test(context)) {
				canonical.set(property, value);
			} else aliases.set(property, [...(aliases.get(property) ?? []), value]);
		}
	}
	let utilities = new Set<string>();
	for (let { file, content, extracted } of sources) {
		if (!file.endsWith(".css") || extracted.errors.length) continue;
		postcss.parse(content).walkAtRules("utility", rule => {
			utilities.add(rule.params);
		});
	}
	let policy = { canonical, aliases, utilities, typographyProperties: foundation?.properties };
	let findings = sources.flatMap(({ file, extracted }) => {
		if (file !== "packages/visuals/theme.css") return inspect(file, extracted, policy);
		// Only direct token definitions own literals; component rules in the theme still count.
		let declarations = extracted.declarations.filter(({ property, context }) => {
			if (!property.startsWith("--") || !/^CSS > @theme(?: static)?$/.test(context)) return true;
			return property.startsWith("--text-")
				&& !/^--text-(\*|(?:2xs|xs|sm|base|lg|xl|2xl)(?:--line-height)?)$/.test(property);
		});
		return inspect(file, { ...extracted, declarations }, policy);
	});
	for (let reason of foundation?.errors ?? []) {
		findings.push({
			file: DIAGRAM_TYPOGRAPHY_SOURCE,
			line: 1,
			family: "parse",
			property: "",
			value: "",
			context: "typography foundation",
			reason,
		});
	}
	return { findings, files: files.length, policy };
}

export function fingerprint(
	entry: Pick<Finding, "file" | "family" | "property" | "value" | "context">,
): string {
	return JSON.stringify([entry.file, entry.family, entry.property, entry.value, entry.context]);
}

export function applyExceptions(findings: Finding[], exceptions: Exception[]): string[] {
	let errors: string[] = [];
	let allowed = new Map<string, Exception>();
	for (let entry of exceptions) {
		let key = fingerprint(entry);
		if (
			!entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1 || allowed.has(key)
			|| entry.family === "parse"
		) {
			errors.push(`Invalid design exception: ${key}`);
		}
		allowed.set(key, entry);
	}
	let counts = new Map<string, number>();
	for (let finding of findings) {
		let key = fingerprint(finding);
		let count = (counts.get(key) ?? 0) + 1;
		counts.set(key, count);
		if (
			finding.dynamic && allowed.has(key)
			&& (!allowed.get(key)?.sourceHash || allowed.get(key)?.sourceHash !== finding.sourceHash)
		) {
			errors.push(
				`${finding.file}:${finding.line} reviewed dynamic owner changed; inspect its data flow and renew the exact exception`,
			);
		}
		if (count > (allowed.get(key)?.count ?? 0)) {
			errors.push(
				`${finding.file}:${finding.line} [${finding.family}] ${finding.property}: ${finding.value} — ${finding.reason}`,
			);
		}
	}
	for (let [key, entry] of allowed) {
		if ((counts.get(key) ?? 0) < entry.count) {
			errors.push(`Stale design exception: ${entry.file} ${entry.property}: ${entry.value}`);
		}
	}
	return errors;
}
