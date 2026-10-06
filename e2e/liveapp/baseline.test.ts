import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

import { applicationBaseline, applicationOwners } from "./baseline";

test("pilot installation preserves application ownership code", async () => {
	let root = resolve(import.meta.dir, "../..");
	for (let file of applicationOwners) {
		let original = Bun.spawnSync(["git", "show", `${applicationBaseline}:${file}`], {
			cwd: root,
		});
		expect(original.exitCode).toBe(0);
		expect(await readFile(resolve(root, file), "utf8")).toBe(original.stdout.toString());
	}
});

test("the packed library matches its record and uses the web workspace's React", async () => {
	let root = resolve(import.meta.dir, "../..");
	let record = JSON.parse(await readFile(resolve(root, "liveapp.package.json"), "utf8"));
	let archive = resolve(root, record.archive);
	expect(createHash("sha256").update(await readFile(archive)).digest("hex")).toBe(record.sha256);
	let web = createRequire(resolve(root, "apps/web/package.json"));
	let libraryEntry = Bun.resolveSync("liveapp/react", resolve(root, "apps/web"));
	let library = createRequire(libraryEntry);
	for (let name of ["react", "react-dom", "react-dom/client"]) {
		expect(library.resolve(name)).toBe(web.resolve(name));
	}
	let packed = Bun.spawnSync(["tar", "-xOf", archive, "package/dist/library/public/react.js"]);
	expect(packed.exitCode).toBe(0);
	expect(await readFile(libraryEntry, "utf8")).toBe(packed.stdout.toString());
});
