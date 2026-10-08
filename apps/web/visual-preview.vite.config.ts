import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	base: "./",
	esbuild: { jsx: "automatic" },
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	build: {
		outDir: "preview/dist/producer",
		emptyOutDir: true,
		copyPublicDir: false,
		target: "es2022",
		lib: {
			entry: fileURLToPath(new URL("./src/visual-preview/frame.tsx", import.meta.url)),
			formats: ["es"],
			fileName: "frame",
			cssFileName: "frame",
		},
	},
});
