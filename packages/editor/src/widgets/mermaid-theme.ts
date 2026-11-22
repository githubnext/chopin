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
 * theme's custom properties directly, and follows a change of the page's theme
 * as the page does. `neutral` stays underneath as the fallback for anything not
 * restyled here, so nothing derives a stray hue. At night it is the same
 * neutral with each of its greys replaced by the step of Chopin's ramp that does
 * that job (`NIGHT`), which turns over with the page; Mermaid bakes those into
 * the drawing, which is why a diagram is drawn again when the theme changes.
 */

import type { MermaidConfig } from "mermaid";
import type { Theme } from "../theme";

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

	/* ER cardinality marks are outlines by design, hollow on the page. */
	marker[id*="_er-"] circle { fill: var(--color-page); }

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

/**
 * Neutral's colours at night, each the token for the job it does by day: its
 * white is the page, its `#eee` shapes the selected grey, its `#666` lines and
 * notes the line grey, its `#333` words the primary ink. Mermaid mixes and
 * compares these in script, so they are read from the page as sRGB when a
 * diagram is drawn rather than handed over as custom properties.
 */
const NIGHT = {
	background: "--color-page",
	primaryColor: "--color-gray-200",
	mainBkg: "--color-gray-200",
	secondaryColor: "--color-gray-300",
	tertiaryColor: "--color-gray-100",
	secondBkg: "--color-gray-50",
	contrast: "--color-gray-500",
	primaryTextColor: "--color-text-primary",
	secondaryTextColor: "--color-text-primary",
	tertiaryTextColor: "--color-text-primary",
	textColor: "--color-text-primary",
	text: "--color-text-primary",
	titleColor: "--color-text-primary",
	labelColor: "--color-text-primary",
	labelTextColor: "--color-text-primary",
	loopTextColor: "--color-text-primary",
	actorTextColor: "--color-text-primary",
	signalTextColor: "--color-text-primary",
	transitionLabelColor: "--color-text-primary",
	taskTextColor: "--color-text-primary",
	taskTextDarkColor: "--color-text-primary",
	taskTextOutsideColor: "--color-text-primary",
	pieTitleTextColor: "--color-text-primary",
	pieSectionTextColor: "--color-text-primary",
	pieLegendTextColor: "--color-text-primary",
	specialStateColor: "--color-text-primary",
	primaryBorderColor: "--color-gray-400",
	secondaryBorderColor: "--color-gray-400",
	tertiaryBorderColor: "--color-gray-400",
	border1: "--color-gray-450",
	border2: "--color-gray-500",
	nodeBorder: "--color-gray-450",
	clusterBkg: "--color-gray-50",
	clusterBorder: "--color-gray-500",
	lineColor: "--color-gray-600",
	defaultLinkColor: "--color-gray-600",
	arrowheadColor: "--color-gray-600",
	signalColor: "--color-gray-600",
	transitionColor: "--color-gray-600",
	stateBorder: "--color-gray-600",
	activationBorderColor: "--color-gray-600",
	edgeLabelBackground: "--color-page",
	relationLabelBackground: "--color-page",
	actorBorder: "--color-gray-300",
	actorBkg: "--color-gray-200",
	labelBoxBkgColor: "--color-gray-200",
	labelBoxBorderColor: "--color-gray-300",
	noteBkgColor: "--color-gray-600",
	noteTextColor: "--color-page",
	noteBorderColor: "--color-gray-450",
	activationBkgColor: "--color-gray-100",
	sequenceNumberColor: "--color-page",
	altBackground: "--color-gray-100",
	compositeBackground: "--color-page",
	altSectionBkgColor: "--color-page",
	excludeBkgColor: "--color-gray-200",
	gridColor: "--color-gray-200",
	doneTaskBkgColor: "--color-gray-400",
	critBkgColor: "--color-destructive",
	todayLineColor: "--color-destructive",
	rowOdd: "--color-page",
	rowEven: "--color-gray-100",
	attributeBackgroundColorOdd: "--color-page",
	attributeBackgroundColorEven: "--color-gray-100",
	pieStrokeColor: "--color-page",
	pieOuterStrokeColor: "--color-gray-450",
	commitLabelBackground: "--color-gray-300",
	commitLabelColor: "--color-text-primary",
	tagLabelBackground: "--color-gray-200",
	tagLabelColor: "--color-text-primary",
} as const;

/**
 * Neutral's twelve scale greys (mindmap branches, timeline periods), at night
 * each a step the primary ink reads on at 4.5:1, alternating as neutral's do.
 */
const NIGHT_SCALE = ["--color-gray-400", "--color-gray-200", "--color-gray-300"] as const;

/**
 * Pie slices are drawn at 70% over the page, which brings them closer to it, so
 * at night they spread wider than the scale: neighbours a step apart, and the
 * primary ink still at 4.5:1 on the lightest.
 */
const NIGHT_PIE = [
	"--color-gray-450",
	"--color-gray-150",
	"--color-gray-400",
	"--color-gray-200",
] as const;

/*
 * The mindmap's root is drawn in the inset grey by `THEME_CSS`, so at night its
 * label is the primary ink rather than the label colour neutral pairs with its
 * own root grey.
 */
const NIGHT_CSS = `
	.section-root span { color: var(--color-text-primary) !important; }
	.section-root text { fill: var(--color-text-primary) !important; }
`;

export type ReadColour = (token: string) => string;

/** The night overrides, every colour one of the page's tokens as `read` gives it. */
export function nightVariables(read: ReadColour): Record<string, string | boolean> {
	let variables: Record<string, string | boolean> = { darkMode: true };
	for (let [name, token] of Object.entries(NIGHT)) variables[name] = read(token);
	for (let index = 0; index < 12; index++) {
		variables[`cScale${index}`] = read(NIGHT_SCALE[index % NIGHT_SCALE.length]!);
		variables[`cScalePeer${index}`] = read("--color-gray-450");
		variables[`cScaleLabel${index}`] = read("--color-text-primary");
		variables[`pie${index + 1}`] = read(NIGHT_PIE[index % NIGHT_PIE.length]!);
		if (index < 8) {
			variables[`git${index}`] = read(index % 2 ? "--color-gray-500" : "--color-gray-600");
			variables[`gitBranchLabel${index}`] = read("--color-page");
			variables[`gitInv${index}`] = read("--color-page");
		}
	}
	return variables;
}

let canvas: CanvasRenderingContext2D | undefined;

/**
 * The page's tokens as sRGB hex, which Mermaid's colour arithmetic can read: a
 * canvas converts whatever space a token is written in, as the page draws it.
 */
function pageColours(): ReadColour {
	let style: CSSStyleDeclaration | undefined;
	let read = new Map<string, string>();
	return token => {
		let known = read.get(token);
		if (known) return known;
		style ??= getComputedStyle(document.documentElement);
		canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		canvas.clearRect(0, 0, 1, 1);
		canvas.fillStyle = style.getPropertyValue(token).trim();
		canvas.fillRect(0, 0, 1, 1);
		let [red, green, blue] = canvas.getImageData(0, 0, 1, 1).data;
		let hex = "#" + [red, green, blue].map(value => value!.toString(16).padStart(2, "0")).join("");
		read.set(token, hex);
		return hex;
	};
}

/**
 * Mermaid measures text with this family in script, so it needs the resolved
 * stack rather than a custom property it cannot read.
 */
function pageFont(): string {
	return getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
}

export function mermaidConfig(
	theme: Theme,
	fontFamily = pageFont(),
	read: ReadColour = pageColours(),
): MermaidConfig {
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
		...(theme === "dark" && { themeVariables: nightVariables(read) }),
		...(fontFamily && { fontFamily }),
		themeCSS: theme === "dark" ? THEME_CSS + NIGHT_CSS : THEME_CSS,
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
