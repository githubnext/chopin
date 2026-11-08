import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `:has()` asked of an element that holds the whole document is searched again, element by
 * element, after every change made anywhere inside it. On a document of 12,000 elements four such
 * rules on `.plan` were a third of the cost of each layout, so a keystroke, a diagram arriving and
 * a pane being dragged each paid it. A rule that needs to know what a smaller part holds asks that
 * part: the preface, not the plan that contains the editor beside it.
 */
let WHOLE_DOCUMENT = /(^|[\s,>+~(])\.(plan|plan-document|plan-workspace|plan-frame):has\(/;

function stylesheets(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		let path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : stylesheets(path);
		return entry.name.endsWith(".css") ? [path] : [];
	});
}

test("no stylesheet asks the plan, which holds the whole document, what it contains", () => {
	let found: string[] = [];
	for (
		let directory of [join(import.meta.dir), join(import.meta.dir, "../../../packages/editor/src")]
	) {
		for (let path of stylesheets(directory)) {
			let source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
			for (let [, selectors] of source.matchAll(/([^{}]+)\{/g)) {
				for (let selector of selectors!.split(",")) {
					if (WHOLE_DOCUMENT.test(selector.trim())) {
						found.push(
							`${path.split("/").slice(-3).join("/")}: ${selector.trim().replace(/\s+/g, " ")}`,
						);
					}
				}
			}
		}
	}
	expect(found).toEqual([]);
});
