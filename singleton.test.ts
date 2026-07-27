/**
 * One copy of the libraries that cannot tolerate two.
 *
 * Lexical throws `incompatible editors` when an editor built by one copy meets
 * a node built by another, and every operation fails from then on. Yjs decides
 * whether an update applies with instanceof checks, so a second copy silently
 * stops merging. React's is the familiar broken-hooks failure.
 *
 * None of these announce themselves usefully at runtime, and all three are
 * prevented by the same thing: every package naming the version through the
 * workspace catalog. This asserts the outcome rather than the discipline,
 * because the discipline is one careless `bun add` away from lapsing.
 */

import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";

const SINGLETONS = ["lexical", "react", "react-dom", "y-protocols", "yjs"];

describe("dependency singletons", () => {
	it("resolves exactly one version of each collaboration-critical package", async () => {
		let entries = await readdir(`${import.meta.dir}/node_modules/.bun`);

		for (let name of SINGLETONS) {
			// Store directories are `name@version`, and `@lexical/yjs` must not
			// be mistaken for `yjs`.
			let versions = entries
				.filter(entry => entry.startsWith(`${name}@`))
				.map(entry => entry.slice(name.length + 1).split("+")[0]);

			expect(versions.length, `${name} is installed ${versions.length} times: ${versions}`)
				.toBe(1);
		}
	});
});
