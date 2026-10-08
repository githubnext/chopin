import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

import { initialJavaScriptBudget } from "./bundle-budget";

import type { ServerOptions } from "vite";

const PORT = Number(process.env.CHOPIN_DEV_WEB_PORT ?? "5173");
const EXE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.exe\.xyz$/;

function openUIRuntimeEntry(): string {
	let require = createRequire(new URL("../../packages/editor/package.json", import.meta.url));
	let packageRoot = dirname(dirname(require.resolve("@openuidev/react-lang")));
	let manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
	let native = manifest.exports?.["."]?.["react-native"]?.import?.default;
	let web = manifest.exports?.["."]?.import?.default;
	if (
		manifest.version !== "0.3.0" || typeof native !== "string" || typeof web !== "string"
		|| !existsSync(resolve(packageRoot, native))
	) {
		throw new Error("Review the OpenUI runtime exports before changing its pinned version");
	}
	// The published native condition has the same API without the web entry's
	// development devtools bootstrap, which fetches code from a CDN.
	return resolve(packageRoot, native);
}

type DevNetwork = Pick<ServerOptions, "host" | "allowedHosts" | "hmr">;

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
	plugins: [react(), tailwindcss(), tsconfigPaths(), initialJavaScriptBudget()],

	resolve: {
		alias: [{ find: /^@openuidev\/react-lang$/, replacement: openUIRuntimeEntry() }],
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
