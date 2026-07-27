import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const PORT = 5173;

export default defineConfig({
	plugins: [react(), tailwindcss(), tsconfigPaths()],

	resolve: {
		// Only what this app resolves itself. Lexical and Yjs belong to the
		// editor package, and listing them here would ask Vite to resolve them
		// from a root that does not have them. Their single-copy guarantee comes
		// from the catalog pin instead, which `singleton.test.ts` asserts.
		dedupe: ["react", "react-dom"],
	},

	server: {
		port: PORT,
		strictPort: true,

		/*
		 * The browser never comes here directly.
		 *
		 * The Bun server is the only origin: it owns `/ws` and forwards
		 * everything else to this process, so development, production and a
		 * tunnel all present one host and port. Vite would otherwise be a
		 * second origin that only exists during development, and the client
		 * would need to know which mode it was in.
		 *
		 * Hot reload is the exception, and deliberately so. Its socket is
		 * pointed straight back here rather than through the server, because
		 * relaying a WebSocket upgrade is the one thing that has to work
		 * perfectly and cannot be tested from here. Nothing proxies a socket.
		 */
		hmr: {
			protocol: "ws",
			host: "localhost",
			clientPort: PORT,
		},
	},
});
