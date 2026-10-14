import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

let root = resolve(import.meta.dir, "../../..");

async function nativeDisclosures(directory: string): Promise<string[]> {
	let entries = await readdir(directory, { withFileTypes: true });
	let findings = await Promise.all(entries.map(async entry => {
		if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) return [];
		let path = join(directory, entry.name);
		if (entry.isDirectory()) return nativeDisclosures(path);
		else if (/\.(tsx?|jsx?|html)$/.test(entry.name)) {
			let source = await readFile(path, "utf8");
			if (
				/<\s*(details|summary)\b/.test(source)
				|| /createElement\(\s*["'](details|summary)["']/.test(source)
			) {
				return [relative(root, path)];
			}
		}
		return [];
	}));
	return findings.flat();
}

test("app disclosures use shared accordions rather than native browser elements", async () => {
	let findings = await Promise.all(
		["apps", "packages"].map(directory => nativeDisclosures(join(root, directory))),
	);
	expect(findings.flat()).toEqual([]);
});
