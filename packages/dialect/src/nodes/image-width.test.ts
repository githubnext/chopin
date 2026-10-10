import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, $isElementNode } from "lexical";

import { exportPlan, importPlan } from "../convert";
import { parse } from "../parse";
import { registry } from "../registry";
import { serialize } from "../serialize";
import { $isImageNode, ImageNode } from "./content";

const REGISTRY = registry();
const IMAGE = '<Image src="https://example.com/x.png" alt="Chart" width="320" />';
const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const ID2 = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const ID3 = "01K0N4W3B7P27CBAEC7A8C8WEA";

function editor(source: string) {
	let instance = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError: error => {
			throw error;
		},
	});
	importPlan(instance, source, { registry: REGISTRY });
	return instance;
}

describe("image widths", () => {
	it("round-trips sized images alone, inline, and in ordinary containers", () => {
		for (
			let source of [
				IMAGE,
				`Before ${IMAGE} after.`,
				`${IMAGE} after.`,
				`Before ${IMAGE}`,
				`<Callout id="${ID}" type="note">\n\n${IMAGE}\n\nCaption.\n\n</Callout>`,
				`<Columns id="${ID}">\n<Column id="${ID2}">\n\n${IMAGE}\n\nCaption.\n\n</Column>\n`
				+ `<Column id="${ID3}">\n\nOther.\n\n</Column>\n</Columns>`,
			]
		) {
			let canonical = serialize(parse(source));
			let output = exportPlan(editor(source), { registry: REGISTRY });
			expect(output).toBe(canonical);
			expect(exportPlan(editor(output), { registry: REGISTRY })).toBe(output);
		}
	});

	it("keeps standalone images inside the ordinary image paragraph", () => {
		let instance = editor(IMAGE);
		instance.getEditorState().read(() => {
			let paragraph = $getRoot().getFirstChild();
			expect(paragraph?.getType()).toBe("paragraph");
			let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
			expect($isImageNode(image)).toBe(true);
			if (!$isImageNode(image)) return;
			expect(image.getWidth()).toBe(320);
			expect(image.exportJSON().planWidth).toBe(320);
		});
	});

	it("stores integer pixel widths and resets auto sizing to ordinary Markdown", () => {
		let instance = editor("![Chart](https://example.com/x.png)\n");
		let update = (width: number) =>
			instance.update(() => {
				let paragraph = $getRoot().getFirstChild();
				let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
				if (!$isImageNode(image)) throw new Error("missing image");
				image.setWidth(width);
			}, { discrete: true });
		instance.getEditorState().read(() => {
			let paragraph = $getRoot().getFirstChild();
			let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
			if (!$isImageNode(image)) throw new Error("missing image");
			expect(image.getWidth()).toBe(0);
			expect(image.exportJSON().planWidth).toBeUndefined();
		});
		update(320);
		expect(exportPlan(instance, { registry: REGISTRY })).toBe(`${IMAGE}\n`);
		update(0);
		expect(exportPlan(instance, { registry: REGISTRY }))
			.toBe("![Chart](https://example.com/x.png)\n");
	});

	it("rejects fractional, negative, nonfinite, and oversized node widths", () => {
		let instance = editor(IMAGE);
		for (let width of [-1, 1.5, 4097, NaN, Infinity]) {
			instance.update(() => {
				let paragraph = $getRoot().getFirstChild();
				let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
				if (!$isImageNode(image)) throw new Error("missing image");
				expect(() => image.setWidth(width)).toThrow();
				expect(() => ImageNode.importJSON({ ...image.exportJSON(), planWidth: width })).toThrow();
			}, { discrete: true });
		}
	});

	it("restores resized images from JSON and preserves legacy automatic size", () => {
		let instance = editor(IMAGE);
		let json = instance.getEditorState().toJSON();
		let restored = editor("");
		restored.setEditorState(restored.parseEditorState(json));
		expect(exportPlan(restored, { registry: REGISTRY })).toBe(`${IMAGE}\n`);
		let ordinary = editor("![](https://example.com/x.png)\n");
		restored.setEditorState(restored.parseEditorState(ordinary.getEditorState().toJSON()));
		expect(exportPlan(restored, { registry: REGISTRY })).toBe("![](https://example.com/x.png)\n");
	});

	it("rejects nonnumeric widths from JSON rather than silently restoring automatic size", () => {
		let instance = editor(IMAGE);
		instance.update(() => {
			let paragraph = $getRoot().getFirstChild();
			let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
			if (!$isImageNode(image)) throw new Error("missing image");
			for (let width of ["320", null, true]) {
				expect(() =>
					ImageNode.importJSON({
						...image.exportJSON(),
						planWidth: width as unknown as number,
					})
				).toThrow();
			}
		}, { discrete: true });
	});
});
