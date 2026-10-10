import { describe, expect, it } from "bun:test";

import { parse } from "./parse";
import { MAX_IMAGE_WIDTH, MAX_IMAGES } from "./limits";
import { assertIntroducedUrls, validate } from "./validate";

import type { Nodes } from "mdast";

function image(src = "https://example.com/x.png", width = "320", alt = "Chart") {
	return `<Image src="${src}" alt="${alt}" width="${width}" />`;
}

function codes(source: string) {
	let result = validate(parse(source));
	return result.ok ? [] : result.issues.map(issue => issue.code);
}

describe("sized image dialect", () => {
	it("accepts only canonical integer widths from 1 to 4096", () => {
		for (let width of ["1", "320", String(MAX_IMAGE_WIDTH)]) {
			expect(codes(image(undefined, width))).toEqual([]);
		}
		for (
			let width of ["0", "-1", "1.5", "4097", "NaN", "Infinity", "320px", "0320", " 320", "1e2"]
		) {
			expect(codes(image(undefined, width))).toContain("bad-attribute-value");
		}
	});

	it("requires src, alt, and width with no children or extra attributes", () => {
		expect(codes('<Image src="https://example.com/x.png" alt="" />'))
			.toContain("missing-attribute");
		expect(codes('<Image src="https://example.com/x.png" width="320" />'))
			.toContain("missing-attribute");
		expect(codes(image(undefined, undefined, ""))).toEqual([]);
		expect(codes(image().replace(" />", ' height="200" />'))).toContain("unknown-attribute");
		expect(codes(image().replace(" />", ">Child</Image>"))).toContain("unexpected-children");
		expect(codes(image().replace('width="320"', "width={320}")))
			.toContain("expression-attribute");
	});

	it("enforces the same image protocols and exact hosted path allowlist", () => {
		for (
			let src of ["http://example.com/x.png", "javascript:alert(1)", "data:image/png;base64,abc"]
		) {
			expect(codes(image(src))).toContain("bad-image-protocol");
		}
		let path = `/images/${"a".repeat(64)}.png`;
		expect(codes(image(path))).toEqual([]);
		for (
			let src of [
				"relative.png",
				"//example.com/x.png",
				`${path}?x=1`,
				path.replace(".png", ".svg"),
			]
		) {
			expect(codes(image(src))).toContain("bad-image");
		}
	});

	it("counts sized and Markdown images toward one shared image limit", () => {
		let ordinary = "![Chart](https://example.com/x.png)";
		let maximum = [image(), ...Array(MAX_IMAGES - 1).fill(ordinary)].join("\n\n");
		expect(codes(maximum)).toEqual([]);
		expect(codes(`${maximum}\n\n${image()}`)).toContain("too-many-images");
	});

	it("rejects disguised URLs introduced as either flow or inline sized images", () => {
		for (let prefix of ["", "Before "]) {
			let tree = parse(`${prefix}${image()}`);
			let node: Nodes | undefined = tree.children[0];
			if (node?.type === "paragraph") node = node.children[1];
			if (node?.type !== "mdxJsxFlowElement" && node?.type !== "mdxJsxTextElement") {
				throw new Error("missing Image");
			}
			let src = node.attributes.find(item =>
				item.type === "mdxJsxAttribute" && item.name === "src"
			);
			if (src?.type !== "mdxJsxAttribute") throw new Error("missing src");
			for (
				let url of [
					"\u0001https://example.com/x.png",
					"https://ex\u200bample.com/x.png",
					"https://example.com/x.png ",
				]
			) {
				src.value = url;
				expect(() => assertIntroducedUrls([], tree.children)).toThrow();
				expect(() => assertIntroducedUrls(tree.children, tree.children)).not.toThrow();
			}
		}
	});

	it("recognizes an existing URL when Markdown images become sized images", () => {
		let url = "https://ex\u200bample.com/x.png";
		let before = parse(`![Chart](${url})`);
		let after = parse(image(url));
		expect(() => assertIntroducedUrls(before.children, after.children)).not.toThrow();
		expect(() => assertIntroducedUrls(after.children, before.children)).not.toThrow();
	});
});
