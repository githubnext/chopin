import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const SERVER = `${process.env.SERVER_HOST || "127.0.0.1"}:${process.env.PORT || 8787}`;

export default defineConfig({
	plugins: [react(), tailwindcss(), tsconfigPaths()],

	resolve: {
		// Two copies of Lexical throw `incompatible editors` and every node
		// operation fails silently afterwards. The same is true of Yjs, whose
		// instanceof checks decide whether an update applies at all.
		dedupe: ["lexical", "yjs", "react", "react-dom"],
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
