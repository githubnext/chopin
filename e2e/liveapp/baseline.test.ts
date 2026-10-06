import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
