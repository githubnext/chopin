import { expect, test } from "bun:test";

import { DIAGRAM_TYPE } from "../src/core/tokens.mjs";
import { textWidth } from "../src/core/text.mjs";
import { renderDiagram } from "../src/render";

for (let value of ["W".repeat(48), "调".repeat(48)]) {
	test(`process steps retain and contain maximum-length text: ${value[0]}`, () => {
		let result = renderDiagram({
			type: "process",
			steps: [{ label: value, sub: value + value.slice(0, 8) }, "Next"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		let node = result.body.match(/<g[^>]*data-sc-node="s0"[^>]*>(.*?)<\/g>/)![1]!;
		let width = Number(node.match(/class="n-box" d="M0,0 L([\d.]+),0/)![1]) + 16;
		for (let role of ["label", "sub"] as const) {
			let lines = [...node.matchAll(new RegExp(`<text class="n-${role}"[^>]*>(.*?)</text>`, "g"))]
				.map(match => match[1]!);
			expect(lines.join("")).toBe(role === "label" ? value : value + value.slice(0, 8));
			expect(lines.length).toBeGreaterThan(1);
			for (let line of lines) {
				expect(textWidth(line, DIAGRAM_TYPE[role])).toBeLessThanOrEqual(width - 32);
			}
		}
	});
}
