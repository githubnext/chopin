import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

import { initialJavaScriptBudget, initialStylesheetBudget } from "./bundle-budget";

import type { Plugin, ServerOptions } from "vite";

const PORT = Number(process.env.CHOPIN_DEV_WEB_PORT ?? "5173");
const EXE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.exe\.xyz$/;
const ASSISTANT_UI_STYLESHEET = resolve(import.meta.dirname, "src/assistant-ui.css")
	.replaceAll("\\", "/");
const COPIED_COMPONENTS_DIR = `${
	resolve(import.meta.dirname, "src/components").replaceAll("\\", "/")
}/`;

type DevNetwork = Pick<ServerOptions, "host" | "allowedHosts" | "hmr">;

/**
 * Copied registry files under `src/components` cannot be edited on disk (`sources.json` checks
 * their hashes), so Vite attaches their shared stylesheet at transform time. A page without a
 * copied element never downloads it, and Vite's preload helper waits for the `<link>` before
 * resolving the dynamic import that mounts the first copy.
 */
export function copiedElementsStyles(
	componentsDir = COPIED_COMPONENTS_DIR,
	stylesheet = ASSISTANT_UI_STYLESHEET,
): Plugin {
	let importLine = `\nimport ${JSON.stringify(stylesheet)};\n`;
	return {
		name: "copied-elements-styles",
		enforce: "pre",
		transform(code, id) {
			let file = id.split("?")[0]!.replaceAll("\\", "/");
			if (!file.startsWith(componentsDir) || !file.endsWith(".tsx")) return null;
			return { code: `${code}${importLine}`, map: null };
		},
	};
}

/** Keeps the copies' CSS in one shared asset across whichever lazy chunks mount them. */
export function assistantUiChunk(
	id: string,
	stylesheet = ASSISTANT_UI_STYLESHEET,
): string | undefined {
	let file = id.split("?")[0]!.replaceAll("\\", "/");
	return file === stylesheet ? "assistant-ui" : undefined;
}

export function devNetwork(exeHost: string | undefined, port = PORT): DevNetwork {
	if (!exeHost) {
		return {
			host: "127.0.0.1",
			allowedHosts: [],
			hmr: { protocol: "ws", host: "127.0.0.1", clientPort: port },
		};
	}
	if (!EXE_HOST.test(exeHost)) {
		throw new Error("CHOPIN_DEV_EXE_HOST must be one exact <vm>.exe.xyz hostname");
	}
	return {
		host: "0.0.0.0",
		allowedHosts: [exeHost],
		hmr: { protocol: "wss", host: exeHost, clientPort: port },
	};
}

export default defineConfig({
	plugins: [
		copiedElementsStyles(),
		react(),
		tailwindcss(),
		tsconfigPaths(),
		initialJavaScriptBudget(),
		initialStylesheetBudget(),
	],
	build: {
		rollupOptions: {
			output: {
				manualChunks: id => assistantUiChunk(id),
			},
		},
	},
	optimizeDeps: {
		esbuildOptions: { minifyWhitespace: true, minifySyntax: true },
	},

	resolve: {
		// Only what this app resolves itself. Lexical and Yjs belong to the
		// editor package, and listing them here would ask Vite to resolve them
		// from a root that does not have them. Their single-copy guarantee comes
		// from the catalog pin instead, which `singleton.test.ts` asserts.
		dedupe: ["react", "react-dom"],
	},

	server: {
		...devNetwork(process.env.CHOPIN_DEV_EXE_HOST),

		/*
		 * One address, explicitly.
		 *
		 * Left to itself Vite binds `localhost`, which resolves to both ::1 and
		 * 127.0.0.1 — and `strictPort` then fails to notice a second instance,
		 * because the two bind different address families and neither sees a
		 * conflict. The result is two dev servers on "the same port", with the
		 * server proxying to whichever the OS resolves first and edits landing
		 * in the one nobody is watching.
		 */
		port: PORT,
		strictPort: true,
		/*
		 * Normal browser traffic never comes here directly.
		 *
		 * The Bun server is the only origin: it owns `/ws` and forwards
		 * everything else to this process, so development, production and a
		 * tunnel all present one host and port. Vite would otherwise be a
		 * second origin that only exists during development, and the client
		 * would need to know which mode it was in.
		 *
		 * Hot reload is the exception. Locally its socket points at loopback; in
		 * exe.dev it uses the VM's private alternate port with the exact VM host
		 * allowlisted. Bun cannot relay it because `/ws` belongs to the product.
		 */
	},
});
