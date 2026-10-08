// Static schema imports keep renderDiagram free of filesystem and network access.
import bar from "./schemas/bar.schema.json";
import common from "./schemas/common.schema.json";
import fishbone from "./schemas/fishbone.schema.json";
import gantt from "./schemas/gantt.schema.json";
import graph from "./schemas/graph.schema.json";
import heatmap from "./schemas/heatmap.schema.json";
import journey from "./schemas/journey.schema.json";
import kanban from "./schemas/kanban.schema.json";
import layers from "./schemas/layers.schema.json";
import line from "./schemas/line.schema.json";
import loop from "./schemas/loop.schema.json";
import matrix from "./schemas/matrix.schema.json";
import nested from "./schemas/nested.schema.json";
import polar from "./schemas/polar.schema.json";
import process from "./schemas/process.schema.json";
import pyramid from "./schemas/pyramid.schema.json";
import quadrant from "./schemas/quadrant.schema.json";
import radar from "./schemas/radar.schema.json";
import sankey from "./schemas/sankey.schema.json";
import scatter from "./schemas/scatter.schema.json";
import sequence from "./schemas/sequence.schema.json";
import stages from "./schemas/stages.schema.json";
import story_map from "./schemas/story-map.schema.json";
import timeline from "./schemas/timeline.schema.json";
import tree from "./schemas/tree.schema.json";
import treemap from "./schemas/treemap.schema.json";
import venn from "./schemas/venn.schema.json";
import wardley from "./schemas/wardley.schema.json";
import waterfall from "./schemas/waterfall.schema.json";

export const SCHEMAS = {
	"bar": bar,
	"common": common,
	"fishbone": fishbone,
	"gantt": gantt,
	"graph": graph,
	"heatmap": heatmap,
	"journey": journey,
	"kanban": kanban,
	"layers": layers,
	"line": line,
	"loop": loop,
	"matrix": matrix,
	"nested": nested,
	"polar": polar,
	"process": process,
	"pyramid": pyramid,
	"quadrant": quadrant,
	"radar": radar,
	"sankey": sankey,
	"scatter": scatter,
	"sequence": sequence,
	"stages": stages,
	"story-map": story_map,
	"timeline": timeline,
	"tree": tree,
	"treemap": treemap,
	"venn": venn,
	"wardley": wardley,
	"waterfall": waterfall,
};
