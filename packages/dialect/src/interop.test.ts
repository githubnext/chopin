/**
 * One Lexical, one Yjs.
 *
 * Two copies of Lexical loaded at once is the worst failure available here:
 * `instanceof` stops working across the boundary, so a node built by one is
 * unrecognisable to the other, every type guard silently returns false, and
 * the editor throws `incompatible editors` if it notices at all. Yjs fails the
 * same way — its update handling is instanceof-driven, so a second copy simply
 * stops merging.
 *
 * The catalog is what prevents it, and the package manager is free to lay out
 * `node_modules` however it likes underneath that. So this asserts the property
 * rather than the layout: that a node constructed through MDXEditor's own
 * visitors is recognised by the Lexical this package imports.
 */

import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode } from "lexical";
import * as Y from "yjs";

import { $importPlan } from "./convert";
import { registry } from "./registry";

describe("module identity", () => {
	it("recognises nodes built by MDXEditor as its own", () => {
		let reg = registry();
		let editor = createHeadlessEditor({
			nodes: reg.nodes,
			onError(err) {
				throw err;
			},
		});

		let seen: string[] = [];
		editor.update(
			() => {
				// The heading and paragraph here are constructed by MDXEditor's
				// core visitors, using whichever Lexical that package resolved.
				$importPlan("# Heading\n\nParagraph.\n", { registry: reg });
				seen = $getRoot().getChildren().map(node => `${node.getType()}:${$isElementNode(node)}`);
			},
			{ discrete: true },
		);

		// False here would mean two copies: the nodes exist, and our own type
		// guard does not believe in them.
		expect(seen).toEqual(["heading:true", "paragraph:true"]);
	});

	it("applies a Yjs update produced by another document", () => {
		let source = new Y.Doc();
		source.getMap("plan").set("probe", "value");

		let target = new Y.Doc();
		Y.applyUpdate(target, Y.encodeStateAsUpdate(source));

		// A second Yjs would leave this undefined rather than throwing.
		expect(target.getMap("plan").get("probe")).toBe("value");
	});
});
