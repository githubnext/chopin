import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import {
	enforceInitialStylesheet,
	INITIAL_STYLESHEET_BUDGET,
	initialStylesheet,
} from "./bundle-budget";
import { assistantUiChunk, copiedElementsStyles, devNetwork } from "./vite.config";

import type { Plugin, Rollup } from "vite";

describe("the Vite development network", () => {
	it("keeps ordinary development on loopback", () => {
		expect(devNetwork(undefined)).toEqual({
			host: "127.0.0.1",
			allowedHosts: [],
			hmr: { protocol: "ws", host: "127.0.0.1", clientPort: 5173 },
		});
	});

	it("keeps HMR on an isolated local development port", () => {
		expect(devNetwork(undefined, 5199)).toEqual({
			host: "127.0.0.1",
			allowedHosts: [],
			hmr: { protocol: "ws", host: "127.0.0.1", clientPort: 5199 },
		});
	});

	it("uses the exact exe.dev host for remote HMR", () => {
		expect(devNetwork("sample-vm.exe.xyz")).toEqual({
			host: "0.0.0.0",
			allowedHosts: ["sample-vm.exe.xyz"],
			hmr: { protocol: "wss", host: "sample-vm.exe.xyz", clientPort: 5173 },
		});
	});

	it("does not accept a broad or malformed host", () => {
		for (let host of [".exe.xyz", "sample-vm.exe.xyz:5173", "evil.test", "Sample.exe.xyz"]) {
			expect(() => devNetwork(host)).toThrow("one exact");
		}
	});
});

describe("copied assistant-ui elements' stylesheet", () => {
	let webRoot = resolve(import.meta.dir);

	async function bundleFixture(files: Record<string, string>): Promise<Rollup.OutputBundle> {
		let base = `${webRoot.replaceAll("\\", "/")}/src/__fixture__/`;
		let virtual = new Map(
			Object.entries(files).map(([name, content]) => [`${base}${name}`, content]),
		);
		let fixturePlugin: Plugin = {
			name: "virtual-fixture",
			enforce: "pre",
			resolveId(source, importer) {
				if (virtual.has(source)) return source;
				if (importer?.startsWith(base) && source.startsWith("./")) {
					let candidate = `${base}${source.slice(2)}`;
					for (let ext of ["", ".tsx", ".ts"]) {
						if (virtual.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
					}
				}
				return null;
			},
			load(id) {
				return virtual.get(id) ?? null;
			},
		};
		let output = await build({
			configFile: false,
			logLevel: "silent",
			root: webRoot,
			plugins: [
				fixturePlugin,
				copiedElementsStyles(),
				react(),
				tailwindcss(),
				tsconfigPaths({ projects: [resolve(webRoot, "tsconfig.json")] }),
			],
			build: {
				write: false,
				rollupOptions: {
					input: `${base}entry.tsx`,
					output: {
						manualChunks: id => assistantUiChunk(id),
					},
				},
			},
		});
		let [result] = Array.isArray(output) ? output : [output];
		if (!result || !("output" in result)) throw new Error("expected Rollup output");
		return Object.fromEntries(result.output.map(item => [item.fileName, item]));
	}

	it("ships copied elements' CSS in one separate stylesheet loaded with the first copy, not in the entry stylesheet", async () => {
		let bundle = await bundleFixture({
			"entry.tsx": `
				import ${JSON.stringify(resolve(webRoot, "src/theme.css"))};
				(globalThis as Record<string, unknown>).copies = [
					() => import("./first-copy"),
					() => import("./second-copy"),
				];
			`,
			"first-copy.tsx": `
				export { ModelSelectorRoot } from "@/components/assistant-ui/elements/model-selector";
			`,
			"second-copy.tsx": `
				export { Button } from "@/components/ui/button";
			`,
		});

		let entryCss = initialStylesheet(bundle);
		expect(() => enforceInitialStylesheet(entryCss, INITIAL_STYLESHEET_BUDGET)).not.toThrow();
		let entryAsset = bundle[entryCss.files[0]!];
		expect(entryAsset?.type).toBe("asset");
		let entrySource = entryAsset?.type === "asset" ? String(entryAsset.source) : "";
		expect(entrySource).not.toContain("[data-slot|=model]");
		expect(entrySource).not.toContain("--color-popover:");

		let lazyChunks = Object.values(bundle).filter(
			(item): item is Rollup.OutputChunk =>
				item.type === "chunk" && !item.isEntry
				&& (item.name === "first-copy" || item.name === "second-copy"),
		);
		expect(lazyChunks).toHaveLength(2);
		let firstCss = [...(lazyChunks[0]!.viteMetadata?.importedCss ?? [])];
		let secondCss = [...(lazyChunks[1]!.viteMetadata?.importedCss ?? [])];
		expect(firstCss).toHaveLength(1);
		expect(secondCss).toEqual(firstCss);
		expect(firstCss[0]).toMatch(/^assets\/assistant-ui-[\w-]+\.css$/);

		let entryChunk = Object.values(bundle).find(
			(item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry,
		);
		expect(entryChunk?.code).toContain(firstCss[0]!);

		let auiAsset = bundle[firstCss[0]!];
		expect(auiAsset?.type).toBe("asset");
		let auiSource = auiAsset?.type === "asset" ? String(auiAsset.source) : "";
		expect(auiSource).toContain("[data-slot|=model]");
		expect(auiSource).toContain("--color-popover:");

		let leakedBundle = await bundleFixture({
			"entry.tsx": `
				import ${JSON.stringify(resolve(webRoot, "src/theme.css"))};
				import { ModelSelectorRoot } from "@/components/assistant-ui/elements/model-selector";
				(globalThis as Record<string, unknown>).copied = ModelSelectorRoot;
			`,
		});
		let leakedCss = initialStylesheet(leakedBundle);
		expect(leakedCss.files.some(file => /^assets\/assistant-ui-[\w-]+\.css$/.test(file))).toBe(
			true,
		);
		expect(() =>
			enforceInitialStylesheet(leakedCss, {
				gzip: entryCss.gzip + 1_000,
				raw: entryCss.raw + 5_000,
			})
		).toThrow(/initial stylesheet .* exceeds budget/);
	});
});
