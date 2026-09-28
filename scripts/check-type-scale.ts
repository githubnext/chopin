#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

let root = dirname(import.meta.dir);
let roles = ["xs", "sm", "base", "lg", "xl", "2xl"];
let token = new RegExp(`^var\\(--text-(?:${roles.join("|")})\\)$`);
let tokenInside = new RegExp(`var\\(--text-(?:${roles.join("|")})\\)`);

function mask(comment: string): string {
	return comment.replace(/[^\n]/g, " ");
}

function files(dir: string): string[] {
	return readdirSync(dir).flatMap(entry => {
		if (["node_modules", "dist", ".impeccable"].includes(entry)) return [];
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) return files(path);
		if (/\.(?:test|spec|e2e)\.[jt]sx?$/.test(entry)) return [];
		return /\.(?:css|html|svg|[jt]sx?)$/.test(entry) ? [path] : [];
	});
}

function unquote(value: string): string {
	let bare = value.trim().replace(/^\{|\}$/g, "").trim();
	return bare.replace(/^["']|["']$/g, "").trim();
}

export function typeScaleProblems(file: string, content: string): string[] {
	let problems: string[] = [];
	let source = content.replace(/\/\*[\s\S]*?\*\//g, mask).replace(/^[\t ]*\/\/.*$/gm, mask);
	let report = (index: number, value: string) => {
		let line = source.slice(0, index).split("\n").length;
		problems.push(`${file}:${line}  ${value}`);
	};

	for (let match of source.matchAll(/\bfont-size\s*:\s*([^;}\n]+)/g)) {
		let value = unquote(match[1]!);
		if (token.test(value) || value === "var(--plan-body)" || value === "inherit") continue;
		report(match.index, `font-size: ${value} must use a type token`);
	}
	for (let match of source.matchAll(/\bfont\s*:\s*([^;}\n]+)/g)) {
		let value = unquote(match[1]!);
		if (
			value === "inherit"
			|| (tokenInside.test(value) && !/(?:^|[\s/])\d*\.?\d+(?:px|rem|em|vw|vh|pt)\b/.test(value))
		) continue;
		report(match.index, `font: ${value} must use a type token`);
	}
	for (let match of source.matchAll(/\bfontSize\s*:\s*(`[^`]*`|"[^"]*"|'[^']*'|[^,}\n]+)/g)) {
		let value = match[1]!.trim();
		if (token.test(unquote(value)) || unquote(value) === "inherit") continue;
		if (file === "apps/web/src/design-audit/foundations.tsx" && value === "`var(${size})`") {
			continue;
		}
		report(match.index, `fontSize: ${value} must use a type token`);
	}
	for (
		let match of source.matchAll(/\b(?:fontSize|font-size)\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})/g)
	) {
		let value = match[1]!.trim();
		if (token.test(unquote(value)) || unquote(value) === "inherit") continue;
		report(match.index, `${match[0]} must use a type token`);
	}
	for (
		let match of source.matchAll(
			/\bsetProperty\(\s*["']font-size["']\s*,\s*(`[^`]*`|"[^"]*"|'[^']*'|[^,)]+)/g,
		)
	) {
		let value = match[1]!.trim();
		if (token.test(unquote(value)) || unquote(value) === "inherit") continue;
		report(match.index, `setProperty(font-size, ${value}) must use a type token`);
	}
	for (let match of source.matchAll(/(--text-([\w-]+))\s*:/g)) {
		let name = match[2]!;
		if (roles.includes(name) || roles.some(role => name === `${role}--line-height`)) continue;
		report(match.index, `${match[1]} is outside the fluid type scale`);
	}
	for (let match of source.matchAll(/\btext-(?:\[[^\]]+\]|\([^)]*\)|\d+xl\b)/g)) {
		if (match[0] === "text-2xl") continue;
		report(match.index, `${match[0]} bypasses the type scale`);
	}
	return problems;
}

if (import.meta.main) {
	let paths = ["apps", "packages"].flatMap(dir => files(join(root, dir)));
	let problems = paths.flatMap(path =>
		typeScaleProblems(relative(root, path), readFileSync(path, "utf8"))
	);
	if (problems.length) {
		console.error(problems.join("\n"));
		process.exit(1);
	}
	console.log(`type scale ok — ${paths.length} source files use named typography roles`);
}
