// Type registry: slug → family, schema, renderer, display name.
import * as graph from "./render/graph/graph.mjs";
import * as sequence from "./render/lanes/sequence.mjs";
import * as tree from "./render/structure/tree.mjs";
import * as bar from "./render/charts/bar.mjs";
import * as sankey from "./render/charts/sankey.mjs";
import * as timeline from "./render/lanes/timeline.mjs";
import * as gantt from "./render/lanes/gantt.mjs";
import * as journey from "./render/lanes/journey.mjs";
import * as line from "./render/charts/line.mjs";
import * as scatter from "./render/charts/scatter.mjs";
import * as wardley from "./render/charts/wardley.mjs";
import { renderPolar, renderRadar } from "./render/charts/radial.mjs";
import { renderHeatmap, renderTreemap, renderWaterfall } from "./render/charts/blocks.mjs";
import * as process_ from "./render/structure/process.mjs";
import * as loop from "./render/structure/loop.mjs";
import * as nested from "./render/structure/nested.mjs";
import * as layers from "./render/structure/layers.mjs";
import * as venn from "./render/structure/venn.mjs";
import * as pyramid from "./render/structure/pyramid.mjs";
import * as fishbone from "./render/structure/fishbone.mjs";
import * as kanban from "./render/structure/kanban.mjs";
import * as storymap from "./render/structure/storymap.mjs";
import * as quadrant from "./render/structure/quadrant.mjs";
import * as matrix from "./render/structure/matrix.mjs";

// schema defaults to the type slug (schemas/<slug>.schema.json)
const ch = (name, renderer, extra = {}) => ({ name, family: "chart", renderer, ...extra });
const st = (name, renderer, extra = {}) => ({ name, family: "structure", renderer, ...extra });
const g = (name, extra = {}) => ({
	name,
	family: "graph",
	schema: "graph",
	renderer: graph,
	...extra,
});

export const TYPES = {
	architecture: g("Architecture"),
	flowchart: g("Flowchart"),
	"data-flow": g("Data flow"),
	dependency: g("Dependency graph"),
	deployment: g("Deployment"),
	"high-level": g("High-level overview"),
	state: g("State machine"),
	er: g("Entity relationship"),
	"db-schema": g("Database schema"),
	"uml-class": g("UML class"),
	swimlane: g("Swimlane"),
	"architecture-delta": g("Architecture delta"),
	"it-state": g("IT current state"),
	medallion: g("Medallion architecture", { schema: "stages" }),
	"dp-integration": g("Data platform integration", { schema: "stages" }),
	sequence: { name: "Sequence", family: "lanes", schema: "sequence", renderer: sequence },
	tree: { name: "Tree", family: "structure", schema: "tree", renderer: tree },
	"org-chart": { name: "Org chart", family: "structure", schema: "tree", renderer: tree },
	timeline: { name: "Timeline", family: "lanes", renderer: timeline },
	gantt: { name: "Gantt", family: "lanes", renderer: gantt, defaultMotion: "reveal" },
	journey: { name: "User journey", family: "lanes", renderer: journey },
	process: st("Process", process_, { defaultMotion: "step" }),
	loop: st("Loop", loop, { defaultMotion: "loop" }),
	nested: st("Nested", nested),
	layers: st("Layer stack", layers),
	venn: st("Venn", venn),
	pyramid: st("Pyramid", pyramid),
	fishbone: st("Fishbone", fishbone, { defaultMotion: "trace" }),
	kanban: st("Kanban", kanban),
	"story-map": st("Story map", storymap),
	quadrant: st("Quadrant", quadrant),
	"dp-security-matrix": st("Data access matrix", matrix, { schema: "matrix" }),
	bar: { name: "Bar chart", family: "chart", schema: "bar", renderer: bar },
	sankey: { name: "Sankey", family: "chart", schema: "sankey", renderer: sankey },
	line: ch("Line chart", line, { defaultMotion: "trace" }),
	scatter: ch("Scatter plot", scatter),
	radar: ch("Radar", { render: renderRadar }),
	polar: ch("Polar chart", { render: renderPolar }, { defaultMotion: "trace" }),
	waterfall: ch("Waterfall", { render: renderWaterfall }),
	treemap: ch("Treemap", { render: renderTreemap }),
	heatmap: ch("Heatmap", { render: renderHeatmap }),
	wardley: ch("Wardley map", wardley, { defaultMotion: "trace" }),
};

// Variant slugs: type name → [base type, variant, extra spec defaults].
export const ALIASES = {
	"quadrant-consultant": ["quadrant", "consultant"],
	"loop-terminal": ["loop", undefined, { skin: "terminal" }],
	"high-level-vertical": ["high-level", "vertical"],
	"sequence-oauth": ["sequence", "oauth"],
	"state-lifecycle": ["state", "lifecycle"],
	"tree-block-decomposition": ["tree", "block"],
	funnel: ["pyramid", "funnel"],
	marimekko: ["bar", "marimekko"],
	dumbbell: ["bar", "dumbbell"],
	slopegraph: ["line", "slope"],
	ridgeline: ["line", "ridgeline"],
	streamgraph: ["line", "stream"],
	bump: ["line", "bump"],
	bubble: ["scatter", "bubble"],
	beeswarm: ["scatter", "beeswarm"],
};

export function resolveAlias(spec) {
	const a = ALIASES[spec.type];
	if (!a || !TYPES[a[0]]) return spec;
	return { ...a[2], ...spec, type: a[0], variant: spec.variant || a[1] };
}

export function typeInfo(slug) {
	return TYPES[slug] || null;
}
