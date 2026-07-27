/**
 * What markdown shortcuts the editor ends up with.
 *
 * `markdownShortcutPlugin` chooses its transformers once, at init, from
 * whichever plugins have registered by then. Register it too early, or drop a
 * dialect plugin it keys off, and the shortcuts it offers quietly shrink — no
 * error, no warning, just a `# ` that stops becoming a heading. This pins the
 * set it reads so that change has to be a deliberate one.
 */

import { describe, expect, it } from "bun:test";
import { activePlugins$ } from "@mdxeditor/editor";
import { Realm } from "@mdxeditor/gurx";

import { plugins } from "@chopin/dialect";

/** The realm as it stands when the shortcut plugin initialises after it. */
function active(): string[] {
	let realm = new Realm();
	for (let plugin of plugins()) plugin.init?.(realm);
	return realm.getValue(activePlugins$);
}

describe("markdown shortcuts", () => {
	it("finds the plugins whose shortcuts the dialect supports", () => {
		// Each of these gates a transformer: headings `# `, lists `- ` and
		// `1. `, quote `> `, link `[text](url)`, thematic break `***`.
		expect(active()).toEqual(["headings", "lists", "quote", "link", "thematicBreak"]);
	});

	it("does not claim the code block shortcut it cannot honour", () => {
		// The dialect brings its own code block node, so MDXEditor's is never
		// registered and its ``` transformer is correctly left out. Were it to
		// appear here, the shortcut would build a node the dialect cannot
		// serialise.
		expect(active()).not.toContain("codeblock");
	});
});
