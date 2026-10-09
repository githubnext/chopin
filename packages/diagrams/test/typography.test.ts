import { expect, test } from "bun:test";

import { DIAGRAM_TYPE, LABEL_BOX } from "../src/core/tokens.mjs";
import { sizeNode } from "../src/core/render/shared/nodes.mjs";
import { textWidth } from "../src/core/text.mjs";
import { renderDiagram } from "../src/render";
import { render as renderTimeline } from "../src/core/render/lanes/timeline.mjs";
import { render as renderGantt } from "../src/core/render/lanes/gantt.mjs";
import { render as renderJourney } from "../src/core/render/lanes/journey.mjs";

test("timeline collision lanes measure subtitles at their rendered role", () => {
	let result = renderTimeline({
		layout: "above",
		events: Array.from(
			{ length: 8 },
			(_, index) => ({ label: String(index), sub: "Subtitlespan" }),
		),
	});
	let subtitles = [...result.body.matchAll(/class="n-sub"[^>]*y="([\d.-]+)"/g)];
	expect(subtitles).toHaveLength(8);
	expect(Number(subtitles[0]![1])).not.toBe(Number(subtitles[1]![1]));
});

test("Gantt section headings reserve their full catalog width before the time axis", () => {
	let section = "Background indexing worker group";
	let result = renderGantt({ tasks: [{ label: "Job", section, start: 0, days: 1 }] });
	let axis = Number(/class="ax-grid"[^>]*x1="([\d.-]+)"/.exec(result.body)![1]);
	expect(axis).toBeGreaterThan(textWidth(section, DIAGRAM_TYPE.tag));
});

test("journey subtitles wrap within their stage and reserve room above the curve", () => {
	let stages = [{
		label: "Stage",
		sub: "A long stage subtitle that cannot fit inside one stage column",
		steps: ["Step"],
	}];
	let result = renderJourney({ stages });
	let subtitles = [...result.body.matchAll(/class="n-sub"[^>]*y="([\d.-]+)"/g)];
	expect(subtitles.length).toBeGreaterThan(2);
	let lastBaseline = Number(subtitles.at(-1)![1]);
	let dot = Number(/class="jr-dot"[^>]*cy="([\d.-]+)"/.exec(result.body)![1]);
	expect(dot - 75).toBeGreaterThanOrEqual(lastBaseline + DIAGRAM_TYPE.sub.lineHeight);
});

test("a long group heading stays within the diagram bounds at the measured tag size", () => {
	let result = renderDiagram({
		type: "architecture",
		nodes: [{ id: "worker", label: "Worker", row: 0, col: 0 }],
		edges: [],
		groups: [{ id: "workers", label: "Background indexing worker group", nodes: ["worker"] }],
		legend: false,
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	let background = result.body.match(/<rect[^>]+class="g-label-bg"[^>]*>/)?.[0];
	expect(background).toBeDefined();
	let width = Number(background?.match(/\bwidth="([^"]+)"/)?.[1]);
	let height = Number(background?.match(/\bheight="([^"]+)"/)?.[1]);
	let x = Number(background?.match(/\bx="([^"]+)"/)?.[1]);
	expect(height).toBe(DIAGRAM_TYPE.tag.lineHeight + LABEL_BOX.badgePaddingBlock * 2);
	expect(result.viewBox[0] + result.viewBox[2]).toBeGreaterThanOrEqual(x + width);
});

test("adding a class stereotype cannot shrink its method compartment", () => {
	let method = "synchronizeRepositoryChanges()";
	let plain = sizeNode({ shape: "class", label: "Worker", methods: [method] });
	let tagged = sizeNode({ shape: "class", label: "Worker", tag: "INTERFACE", methods: [method] });
	expect(tagged.w).toBeGreaterThanOrEqual(plain.w);
	expect(tagged.w).toBeGreaterThan(textWidth(method, DIAGRAM_TYPE.sub));
});
