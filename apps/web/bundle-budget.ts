import { gzipSync } from "node:zlib";

import type { Plugin } from "vite";

export type BundleItem = {
	type: "chunk";
	fileName: string;
	isEntry: boolean;
	imports: string[];
	dynamicImports: string[];
	code: string;
} | { type: "asset" };

export type InitialJavaScript = { files: string[]; gzip: number; raw: number };
export type JavaScriptBudget = { gzip: number; raw: number };

export const INITIAL_JAVASCRIPT_BUDGET: JavaScriptBudget = {
	gzip: 80_000,
	raw: 255_000,
};

export function enforceInitialJavaScript(
	measured: InitialJavaScript,
	budget: JavaScriptBudget,
): void {
	if (measured.raw <= budget.raw && measured.gzip <= budget.gzip) return;
	throw new Error(
		`initial JavaScript ${measured.raw} B raw / ${measured.gzip} B gzip exceeds budget ${budget.raw} B raw / ${budget.gzip} B gzip`,
	);
}

export function initialJavaScript(bundle: Record<string, BundleItem>): InitialJavaScript {
	let chunks = Object.values(bundle).filter(item => item.type === "chunk");
	let entries = chunks.filter(chunk => chunk.isEntry);
	if (entries.length !== 1) {
		throw new Error(`expected one JavaScript entry, found ${entries.length}`);
	}

	let byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
	let pending = [entries[0]!.fileName];
	let files: string[] = [];
	let measured: typeof chunks = [];
	while (pending.length > 0) {
		let file = pending.shift()!;
		if (files.includes(file)) continue;
		let chunk = byName.get(file);
		if (!chunk) throw new Error(`initial JavaScript imports missing chunk ${file}`);
		files.push(file);
		measured.push(chunk);
		pending.push(...chunk.imports);
	}

	return {
		files,
		gzip: measured.reduce((total, chunk) => total + gzipSync(chunk.code).byteLength, 0),
		raw: measured.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
	};
}

export function initialJavaScriptBudget(
	budget = INITIAL_JAVASCRIPT_BUDGET,
): Plugin {
	return {
		name: "initial-javascript-budget",
		apply: "build",
		enforce: "post",
		writeBundle(_options, bundle) {
			let measured = initialJavaScript(bundle);
			console.info(
				`[bundle-budget] initial JavaScript: ${measured.raw} B raw / ${measured.gzip} B gzip (${
					measured.files.join(", ")
				})`,
			);
			enforceInitialJavaScript(measured, budget);
		},
	};
}
