import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const SERVER = `${process.env.SERVER_HOST || "127.0.0.1"}:${process.env.PORT || 8787}`;

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
		port: 5173,
		strictPort: true,
		// The client builds its socket URL from `location`, so the dev server has
		// to carry `/ws` for it. One origin in every mode.
		proxy: {
			"/ws": { target: `ws://${SERVER}`, ws: true },
		},
	},
});
