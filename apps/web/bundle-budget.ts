import { gzipSync } from "node:zlib";

import type { Plugin } from "vite";

export type BundleItem =
	| {
		type: "chunk";
		fileName: string;
		isEntry: boolean;
		imports: string[];
		dynamicImports: string[];
		code: string;
		viteMetadata?: { importedCss: ReadonlySet<string> };
	}
	| {
		type: "asset";
		fileName?: string;
		source?: string | Uint8Array;
	};

export type InitialJavaScript = { files: string[]; gzip: number; raw: number };
export type JavaScriptBudget = { gzip: number; raw: number };
export type InitialStylesheet = { files: string[]; gzip: number; raw: number };
export type StylesheetBudget = { gzip: number; raw: number };

// Includes the keyboard focus recovery and document-creation guards/progress.
// The latter adds a 1 KB compressed allowance, including Linux gzip variation.
// Shared menu dismissal and the account menu keyboard contract add 1 KB raw.
// The combined workspace loading shapes need a further 500 B allowance on Linux.
// The sidebar's Machines entry, its loading row and its lazy chunks add 500 B raw.
// Titled inline notices and the entry's connected-of-paired count add a further 500 B raw.
// Early document-route code loading measures 82,050 B gzip on Linux; allow its preload wrapper
// while retaining the raw limit and keeping the editor out of project-only navigation.
// A document's Machine, in the title menu every sidebar row shares, adds 500 B raw.
// The sidebar's Machines menu, on Base UI Menu, adds about 50 B gzip on Linux; allow 200 B.
// Reloading for a chunk a deploy removed, with the registry of unsaved work it asks, and the
// reconnect that reads a server restart, measure 258,947 B raw and 82,789 B gzip in the
// container's Linux build; allow about 500 B raw and 200 B gzip above that.
// Telling a lost connection once, by the banner and not again at the top of the page, measures
// 259,493 B raw and 83,031 B gzip in the container's Linux build; allow about 500 B raw and 200 B
// gzip above that.
// Every face drawing the picture the server stored for its login, with the page's one map of them,
// the order a face tries its pictures in and what the room's frames teach the map, measures
// 260,106 B raw and 83,267 B gzip in the container build; allow about 400 B raw and 180 B gzip above that.
export const INITIAL_JAVASCRIPT_BUDGET: JavaScriptBudget = {
	gzip: 83_450,
	raw: 260_500,
};

// With copied assistant-ui elements' utilities, geometry layer and animations split into their own
// stylesheet loaded with the first copied element, the initial stylesheet measures 183,416 B raw
// and 32,543 B gzip in the container build (184,180 B raw and 32,623 B gzip locally); allow about
// 800 B raw and 375 B gzip above the local build so any leaked copy (~93.6 KB raw / ~12.0 KB gzip) fails.
export const INITIAL_STYLESHEET_BUDGET: StylesheetBudget = {
	gzip: 33_000,
	raw: 185_000,
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

export function enforceInitialStylesheet(
	measured: InitialStylesheet,
	budget: StylesheetBudget,
): void {
	if (measured.raw <= budget.raw && measured.gzip <= budget.gzip) return;
	throw new Error(
		`initial stylesheet ${measured.raw} B raw / ${measured.gzip} B gzip exceeds budget ${budget.raw} B raw / ${budget.gzip} B gzip`,
	);
}

type BundleChunk = Extract<BundleItem, { type: "chunk" }>;

function entryChunks(bundle: Record<string, BundleItem>, label: string): BundleChunk[] {
	let chunks = Object.values(bundle).filter((item): item is BundleChunk => item.type === "chunk");
	let entries = chunks.filter(chunk => chunk.isEntry);
	if (entries.length !== 1) {
		throw new Error(`expected one JavaScript entry, found ${entries.length}`);
	}

	let byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
	let pending = [entries[0]!.fileName];
	let seen = new Set<string>();
	let measured: BundleChunk[] = [];
	while (pending.length > 0) {
		let file = pending.shift()!;
		if (seen.has(file)) continue;
		let chunk = byName.get(file);
		if (!chunk) throw new Error(`${label} imports missing chunk ${file}`);
		seen.add(file);
		measured.push(chunk);
		pending.push(...chunk.imports);
	}
	return measured;
}

export function initialJavaScript(bundle: Record<string, BundleItem>): InitialJavaScript {
	let measured = entryChunks(bundle, "initial JavaScript");
	return {
		files: measured.map(chunk => chunk.fileName),
		gzip: measured.reduce((total, chunk) => total + gzipSync(chunk.code).byteLength, 0),
		raw: measured.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
	};
}

export function initialStylesheet(bundle: Record<string, BundleItem>): InitialStylesheet {
	let chunks = entryChunks(bundle, "initial stylesheet");
	let assets = new Map(
		Object.entries(bundle).flatMap(([key, item]) =>
			item.type === "asset" ? [[item.fileName ?? key, item] as const] : []
		),
	);
	let files: string[] = [];
	let sources: (string | Uint8Array)[] = [];
	for (let chunk of chunks) {
		for (let file of chunk.viteMetadata?.importedCss ?? []) {
			if (files.includes(file)) continue;
			let asset = assets.get(file);
			if (!asset || asset.source === undefined) {
				throw new Error(`initial stylesheet imports missing asset ${file}`);
			}
			files.push(file);
			sources.push(asset.source);
		}
	}
	if (files.length === 0) {
		throw new Error("expected at least one initial stylesheet, found 0");
	}
	return {
		files,
		gzip: sources.reduce((total, source) => total + gzipSync(source).byteLength, 0),
		raw: sources.reduce(
			(total, source) =>
				total + (typeof source === "string" ? Buffer.byteLength(source) : source.byteLength),
			0,
		),
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

export function initialStylesheetBudget(
	budget = INITIAL_STYLESHEET_BUDGET,
): Plugin {
	return {
		name: "initial-stylesheet-budget",
		apply: "build",
		enforce: "post",
		writeBundle(_options, bundle) {
			let measured = initialStylesheet(bundle);
			console.info(
				`[bundle-budget] initial stylesheet: ${measured.raw} B raw / ${measured.gzip} B gzip (${
					measured.files.join(", ")
				})`,
			);
			enforceInitialStylesheet(measured, budget);
		},
	};
}
