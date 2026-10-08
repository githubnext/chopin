import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

let directory = resolve(import.meta.dir, "../apps/web/dist/assets");
let files = await readdir(directory);
let bundles = files.filter(file => /\.(js|css)$/.test(file));
if (!bundles.length) {
	throw new Error("Build the production client before checking audit exclusion.");
}
for (let file of bundles) {
	let source = await readFile(resolve(directory, file), "utf8");
	if (
		/data-design-audit|Chopin design audit|interactive-document-actions|\.design-audit|diagram-gallery|SeeCode rendering gallery/
			.test(source)
	) {
		throw new Error(`Development preview leaked into production bundle: ${file}`);
	}
}
console.log(
	`Production preview exclusion verified across ${bundles.length} JavaScript/CSS assets.`,
);
