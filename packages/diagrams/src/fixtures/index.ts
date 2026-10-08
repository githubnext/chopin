import type { DiagramSpec } from "../render";

import spec0 from "./specs/charts/bar.json";
import spec1 from "./specs/charts/heatmap.json";
import spec2 from "./specs/charts/line.json";
import spec3 from "./specs/charts/polar.json";
import spec4 from "./specs/charts/radar.json";
import spec5 from "./specs/charts/sankey.json";
import spec6 from "./specs/charts/scatter.json";
import spec7 from "./specs/charts/treemap.json";
import spec8 from "./specs/charts/waterfall.json";
import spec9 from "./specs/data-platform/dp-integration.json";
import spec10 from "./specs/data-platform/dp-security-matrix.json";
import spec11 from "./specs/data-platform/medallion.json";
import spec12 from "./specs/process/data-flow.json";
import spec13 from "./specs/process/flowchart.json";
import spec14 from "./specs/process/gantt.json";
import spec15 from "./specs/process/journey.json";
import spec16 from "./specs/process/kanban.json";
import spec17 from "./specs/process/loop.json";
import spec18 from "./specs/process/process.json";
import spec19 from "./specs/process/sequence.json";
import spec20 from "./specs/process/state.json";
import spec21 from "./specs/process/story-map.json";
import spec22 from "./specs/process/swimlane.json";
import spec23 from "./specs/process/timeline.json";
import spec24 from "./specs/structure/fishbone.json";
import spec25 from "./specs/structure/layers.json";
import spec26 from "./specs/structure/nested.json";
import spec27 from "./specs/structure/org-chart.json";
import spec28 from "./specs/structure/pyramid.json";
import spec29 from "./specs/structure/quadrant.json";
import spec30 from "./specs/structure/tree.json";
import spec31 from "./specs/structure/venn.json";
import spec32 from "./specs/structure/wardley.json";
import spec33 from "./specs/systems/architecture-delta.json";
import spec34 from "./specs/systems/architecture.json";
import spec35 from "./specs/systems/db-schema.json";
import spec36 from "./specs/systems/dependency.json";
import spec37 from "./specs/systems/deployment.json";
import spec38 from "./specs/systems/er.json";
import spec39 from "./specs/systems/high-level.json";
import spec40 from "./specs/systems/it-state.json";
import spec41 from "./specs/systems/uml-class.json";

export const DIAGRAM_FIXTURES: ReadonlyArray<{ type: string; family: string; spec: DiagramSpec }> =
	[
		{ type: "bar", family: "charts", spec: spec0 },
		{ type: "heatmap", family: "charts", spec: spec1 },
		{ type: "line", family: "charts", spec: spec2 },
		{ type: "polar", family: "charts", spec: spec3 },
		{ type: "radar", family: "charts", spec: spec4 },
		{ type: "sankey", family: "charts", spec: spec5 },
		{ type: "scatter", family: "charts", spec: spec6 },
		{ type: "treemap", family: "charts", spec: spec7 },
		{ type: "waterfall", family: "charts", spec: spec8 },
		{ type: "dp-integration", family: "data-platform", spec: spec9 },
		{ type: "dp-security-matrix", family: "data-platform", spec: spec10 },
		{ type: "medallion", family: "data-platform", spec: spec11 },
		{ type: "data-flow", family: "process", spec: spec12 },
		{ type: "flowchart", family: "process", spec: spec13 },
		{ type: "gantt", family: "process", spec: spec14 },
		{ type: "journey", family: "process", spec: spec15 },
		{ type: "kanban", family: "process", spec: spec16 },
		{ type: "loop", family: "process", spec: spec17 },
		{ type: "process", family: "process", spec: spec18 },
		{ type: "sequence", family: "process", spec: spec19 },
		{ type: "state", family: "process", spec: spec20 },
		{ type: "story-map", family: "process", spec: spec21 },
		{ type: "swimlane", family: "process", spec: spec22 },
		{ type: "timeline", family: "process", spec: spec23 },
		{ type: "fishbone", family: "structure", spec: spec24 },
		{ type: "layers", family: "structure", spec: spec25 },
		{ type: "nested", family: "structure", spec: spec26 },
		{ type: "org-chart", family: "structure", spec: spec27 },
		{ type: "pyramid", family: "structure", spec: spec28 },
		{ type: "quadrant", family: "structure", spec: spec29 },
		{ type: "tree", family: "structure", spec: spec30 },
		{ type: "venn", family: "structure", spec: spec31 },
		{ type: "wardley", family: "structure", spec: spec32 },
		{ type: "architecture-delta", family: "systems", spec: spec33 },
		{ type: "architecture", family: "systems", spec: spec34 },
		{ type: "db-schema", family: "systems", spec: spec35 },
		{ type: "dependency", family: "systems", spec: spec36 },
		{ type: "deployment", family: "systems", spec: spec37 },
		{ type: "er", family: "systems", spec: spec38 },
		{ type: "high-level", family: "systems", spec: spec39 },
		{ type: "it-state", family: "systems", spec: spec40 },
		{ type: "uml-class", family: "systems", spec: spec41 },
	];
