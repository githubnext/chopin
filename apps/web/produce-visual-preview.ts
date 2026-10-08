import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundlePolicy, sha256, verifyBundle } from "../server/src/visual-preview/policy";

let output = fileURLToPath(new URL("./preview/dist/", import.meta.url));
let js = await readFile(`${output}producer/frame.js`, "utf8");
let css = await readFile(`${output}producer/frame.css`, "utf8");
for (let asset of css.matchAll(/url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/gi)) {
	if (!(asset[1] ?? asset[2])?.startsWith("data:")) {
		throw new Error("Preview asset is not embedded");
	}
}
// Preserve raw-text string semantics while preventing an embedded closing tag.
let script = `\n${js.replace(/<\/script/gi, "<\\/script")}\n`;
let style = `\n${css.replace(/<\/style/gi, "<\\/style")}\n`;
let html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision card preview</title><style>${style}</style></head>
<body><div id="preview-root"></div><script type="module">${script}</script></body></html>
`;
let bytes = Buffer.from(html);
let manifest = verifyBundle({
	version: 1,
	specimen: "decision-card-v1",
	bundle: { bytes: bytes.byteLength, sha256: sha256(bytes) },
	baseline: { optionPadding: 6, selectedColor: "#E1ECEF" },
	csp: bundlePolicy(html),
}, bytes);
await mkdir(output, { recursive: true });
await writeFile(`${output}bundle.html`, bytes);
await writeFile(`${output}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Visual preview: ${bytes.byteLength} bytes, sha256:${manifest.bundle.sha256}`);
