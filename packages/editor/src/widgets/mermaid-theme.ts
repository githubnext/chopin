/**
 * Chopin's Mermaid theme.
 *
 * Stock Mermaid keeps the parser and the layout — that is what every other
 * Markdown renderer shows for the same source, so a diagram reads the same
 * here and on GitHub. Only the drawing is restyled: light inset shapes with
 * medium-weight labels, hairline borders, boxed edge labels, quiet lines and
 * petrol arrowheads.
 *
 * Mermaid inlines the SVG into the page, so its stylesheet can read the
 * theme's custom properties directly. `neutral` stays underneath as the
 * fallback for anything not restyled here, so nothing derives a stray hue.
 */

import type { MermaidConfig } from "mermaid";

/*
 * Mermaid nests this under the diagram's id, which ranks it alongside its own
 * rules. A few of those are more specific, or written inline, and need
 * `!important` to be overridden at all.
 */
const THEME_CSS = `
	.node .label-container, .node .label-container path, .actor, .er.entityBox {
		fill: var(--color-inset);
		stroke: var(--color-gray-300);
		stroke-width: var(--edge-width);
	}
	rect.label-container, .actor, .er.entityBox { rx: var(--radius-sm); ry: var(--radius-sm); }
	g.node[id^="classId-"] rect.label-container { rx: var(--radius-md); ry: var(--radius-md); }

	.nodeLabel, .node text tspan, .statediagram-state text tspan {
		color: var(--color-text-primary);
		fill: var(--color-text-primary);
		font-weight: 500 !important;
	}
	.node .label-group tspan { font-weight: 600 !important; }
	.node .members-group tspan, .node .methods-group tspan { font-weight: 400 !important; }

	.flowchart-link, .relation, .transition, .messageLine0, .messageLine1 {
		stroke: var(--color-gray-400);
		stroke-width: var(--edge-width);
	}
	.messageText, .edgeLabel, .labelText {
		color: var(--color-text-tertiary);
		fill: var(--color-text-tertiary);
	}

	/* Arrowheads, but not ER cardinality marks, which are outlines by design. */
	marker:not([id*="_er-"]) path, .arrowheadPath {
		fill: var(--color-brand) !important;
		stroke: var(--color-brand) !important;
	}

	/* "yes", "no", "revise": a small box around each edge label. */
	.edgeLabels foreignObject { overflow: visible; }
	/*
	 * Mermaid sized the label for its bare text, and the editor's prose rules
	 * reach the paragraph inside: size the box to the text so it never wraps.
	 */
	.labelBkg:has(p) {
		display: inline-block !important;
		padding: 1px 5px;
		transform: translate(-6px, -2px);
		background: var(--color-page) !important;
		border: var(--edge-width) solid var(--color-gray-300);
		border-radius: var(--radius-sm);
	}
	.labelBkg p { margin: 0; white-space: nowrap; }

	/* Sequence: named, readable actors and a lifeline that is easy to follow. */
	text.actor-box { font-weight: 600 !important; fill: var(--color-text-primary) !important; }
	.actor-line { stroke: var(--color-gray-400); stroke-width: var(--edge-width); stroke-dasharray: 6 5; }

	/* Gantt: quiet sections and petrol-washed tasks instead of dark bars. */
	.section0, .section2 { fill: var(--color-inset); }
	.section1, .section3 { fill: var(--color-page); }
	.grid .tick line { stroke: var(--color-gray-200); }
	rect.task { fill: var(--color-brand-wash); stroke: var(--color-brand); rx: var(--radius-sm); ry: var(--radius-sm); }
	rect.task[class*="done"] { fill: var(--color-inset); stroke: var(--color-gray-400); }
	.taskText, .taskTextOutsideRight, .taskTextOutsideLeft { fill: var(--color-text-primary) !important; }

	/* State: a larger, solid start and end. */
	circle.state-start { r: 9px; fill: var(--color-text-primary) !important; stroke: var(--color-text-primary) !important; }
	g.node[id*="_end-"] > g { transform: scale(1.25); }
	g.node[id*="_end-"] > g > path { fill: var(--color-page); stroke: var(--color-text-primary); }
	g.node[id*="_end-"] > g > g path { fill: var(--color-text-primary); stroke: var(--color-text-primary); }
`;

export function mermaidConfig(): MermaidConfig {
	// Mermaid measures text with this family in script, so it needs the
	// resolved stack rather than a custom property it cannot read.
	let fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-sans")
		.trim();
	return {
		startOnLoad: false,
		// Its own error drawing is a temporary full-page SVG appended to body,
		// and a parse failure throws before Mermaid removes it. The preview
		// already presents the error beside the source that caused it.
		suppressErrorRendering: true,
		// Diagrams come from collaborators and agents, so scripts and click
		// handlers stay off. Strict still draws HTML labels, sanitized with
		// DOMPurify, as GitHub, GitLab and Docusaurus do: Mermaid's SVG-text
		// labels mangle `->`, `=>`, `<`, `&` and entity codes (mermaid#7016).
		securityLevel: "strict",
		theme: "neutral",
		...(fontFamily && { fontFamily }),
		themeCSS: THEME_CSS,
		flowchart: { padding: 14, nodeSpacing: 36, rankSpacing: 40 },
		// One row of actors: the bottom copy repeats the top for no new information.
		sequence: { mirrorActors: false, actorMargin: 60 },
	};
}

/** Room below the last message, so lifelines visibly continue past it. */
const SEQUENCE_TAIL = 32;

/** How far an arrowhead stops short of the shape it points at. */
const ARROW_GAP = 4;
/** State diagrams draw the end state larger than Mermaid measured it. */
const STATE_ARROW_GAP = 6;

/**
 * What the stylesheet cannot reach. Needs measured geometry, so the SVG must
 * be in the document when this runs.
 */
export function refineDiagram(svg: SVGSVGElement) {
	// Sequence lifelines end at the drawing's edge, flush with the last message.
	if (svg.getAttribute("aria-roledescription") === "sequence") {
		let [x, y, width, height] = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(
			Number,
		);
		if (Number.isFinite(height)) {
			svg.setAttribute("viewBox", `${x} ${y} ${width} ${height! + SEQUENCE_TAIL}`);
		}
	}

	// A gap between each arrowhead and its target: pull the marker back along
	// the line and trim the line by the same amount so it doesn't poke through.
	// Dashed edges keep their own pattern, so only solid ones are trimmed.
	for (
		let path of svg.querySelectorAll<SVGPathElement>(
			"path.flowchart-link.edge-pattern-solid, path.transition.edge-pattern-solid",
		)
	) {
		let length = path.getTotalLength();
		let gap = path.classList.contains("transition") ? STATE_ARROW_GAP : ARROW_GAP;
		path.style.strokeDasharray = `${Math.max(0, length - gap)} ${length}`;
	}
	for (let marker of svg.querySelectorAll("marker[id$='flowchart-v2-pointEnd']")) {
		// A 10-unit viewBox drawn 8 wide: 0.8px per marker unit.
		marker.setAttribute("refX", String(5 + ARROW_GAP / 0.8));
	}
	for (let marker of svg.querySelectorAll("marker[id$='stateDiagram-barbEnd']")) {
		marker.setAttribute("refX", String(19 + STATE_ARROW_GAP));
	}

	// Class boxes are a hand-built path with square corners; swap in a
	// rounded rectangle of the same bounds.
	for (
		let container of svg.querySelectorAll<SVGGElement>(
			"g.node[id^='classId-'] > g.basic.label-container",
		)
	) {
		let box = container.getBBox();
		let rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		rect.setAttribute("x", String(box.x));
		rect.setAttribute("y", String(box.y));
		rect.setAttribute("width", String(box.width));
		rect.setAttribute("height", String(box.height));
		rect.setAttribute("class", "label-container");
		container.replaceChildren(rect);
	}
}
