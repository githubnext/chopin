import { build } from "vite";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export let directory = import.meta.dir;
export let output = join(directory, ".built");
export async function buildPreview() {
	await build({
		configFile: false,
		root: directory,
		base: "/",
		build: {
			outDir: output,
			emptyOutDir: true,
			sourcemap: false,
			assetsInlineLimit: 0,
			rollupOptions: {
				input: {
					host: join(directory, "index.html"),
					preview: join(directory, "preview.html"),
					reference: join(directory, "fixture-app/index.html"),
				},
			},
		},
	});
	let entries = await readdir(output, { recursive: true, withFileTypes: true });
	let files = await Promise.all(
		entries.filter((entry) => entry.isFile()).map(async (entry) => {
			let path = join(entry.parentPath, entry.name);
			return {
				path: relative(output, path),
				sha256: createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer()))
					.digest("hex"),
			};
		}),
	);
	files.sort((a, b) => a.path.localeCompare(b.path));
	await Bun.write(
		join(output, "resources.json"),
		JSON.stringify({ description: "Local example build resources", files }, null, 2),
	);
}
if (import.meta.main) await buildPreview();
