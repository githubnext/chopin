import { describe, expect, it } from "bun:test";

import { topLevelChunks } from "./chunk";

describe("top-level MDX chunks", () => {
	it("reassembles canonical blocks byte for byte", () => {
		let source = [
			"# Heading\n\n",
			"Paragraph with café and 計画.\n\n",
			"```ts\nconst value = 1;\n```\n\n",
			"| A | B |\n| - | - |\n| 1 | 2 |\n\n",
			'<Callout type="info">\n\nNested text.\n\n</Callout>\n',
		].join("");
		let chunks = topLevelChunks(source, 50);

		expect(chunks.map(chunk => chunk.source).join("")).toBe(source);
		expect(chunks.every(chunk => chunk.bytes === Buffer.byteLength(chunk.source))).toBe(true);
		expect(
			chunks.flatMap(chunk =>
				Array.from(
					{ length: chunk.lastBlock - chunk.firstBlock + 1 },
					(_, index) => chunk.firstBlock + index,
				)
			),
		).toEqual([0, 1, 2, 3, 4]);
		expect(chunks.some(chunk => chunk.source.includes("```ts\nconst value = 1;\n```"))).toBe(true);
		expect(chunks.some(chunk => chunk.source.includes("<Callout"))).toBe(true);
	});

	it("keeps an oversized block whole", () => {
		let source = `# Heading\n\n${"long ".repeat(40)}\n`;
		let chunks = topLevelChunks(source, 20);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]!.source).toBe(`${"long ".repeat(40)}\n`);
		expect(chunks[1]!.bytes).toBeGreaterThan(20);
	});

	it("handles empty source and rejects invalid targets", () => {
		expect(topLevelChunks("", 100)).toEqual([]);
		expect(topLevelChunks("  \n", 100)).toEqual([{
			source: "  \n",
			firstBlock: 0,
			lastBlock: 0,
			bytes: 3,
		}]);
		expect(() => topLevelChunks("# Plan\n", 0)).toThrow("positive integer");
	});
});
