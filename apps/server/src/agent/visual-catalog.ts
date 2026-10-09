import { DIAGRAM_TYPES, type DiagramSpec } from "@chopin/diagrams";
import { DIAGRAM_FIXTURES } from "@chopin/diagrams/fixtures";

type Description = { fits: string; requires: string };

/** Selection criteria for canonical SeeCode types; aliases remain presentation variants. */
export const VISUAL_DESCRIPTIONS: Readonly<Record<string, Description>> = {
	architecture: {
		fits: "System components and directed connections.",
		requires: "Named parts and supported links.",
	},
	flowchart: {
		fits: "Steps with conditions and branching outcomes.",
		requires: "Steps, branch conditions, and continuations.",
	},
	"data-flow": {
		fits: "Movement or transformation of data between parts.",
		requires: "Data sources, destinations, and transfers.",
	},
	dependency: {
		fits: "Directed prerequisites or component reliance.",
		requires: "Named endpoints and dependency direction.",
	},
	deployment: {
		fits: "Software services placed on runtime infrastructure.",
		requires: "Services, hosts, and deployment links.",
	},
	"high-level": {
		fits: "A small overview of actors and systems.",
		requires: "Named actors, systems, and their links.",
	},
	state: {
		fits: "One entity changing among named states.",
		requires: "States and supported transitions.",
	},
	er: {
		fits: "Entities and their data relationships.",
		requires: "Entities, relationships, and known cardinality.",
	},
	"db-schema": {
		fits: "Database tables and their relations.",
		requires: "Tables, known fields, and relations.",
	},
	"uml-class": {
		fits: "Software classes and structural relations.",
		requires: "Classes and evidenced inheritance or associations.",
	},
	swimlane: {
		fits: "Process steps assigned to distinct owners or systems.",
		requires: "Lanes, steps, and handoffs.",
	},
	"architecture-delta": {
		fits: "A supported before-to-after system change.",
		requires: "Current and proposed components and changed links.",
	},
	"it-state": {
		fits: "A named current or target IT topology.",
		requires: "Systems, boundaries, and known relationships.",
	},
	medallion: {
		fits: "Data processing through bronze, silver, and gold stages.",
		requires: "Stage inputs, transformations, and outputs.",
	},
	"dp-integration": {
		fits: "Integration among data platform services.",
		requires: "Named services and supported exchanges.",
	},
	sequence: {
		fits: "Ordered runtime messages between actors.",
		requires: "Participants, senders, receivers, and message order.",
	},
	tree: { fits: "A parent-child hierarchy.", requires: "Items and supported parentage." },
	"org-chart": {
		fits: "People or teams in a reporting hierarchy.",
		requires: "Roles or teams and reporting lines.",
	},
	timeline: {
		fits: "Events along a known temporal order.",
		requires: "Events and dates or explicit order.",
	},
	gantt: {
		fits: "Tasks scheduled over durations.",
		requires: "Tasks, start/end times, and dependencies if shown.",
	},
	journey: {
		fits: "A person's stages through an experience.",
		requires: "Stages and supported actions or observations.",
	},
	process: {
		fits: "A linear or staged procedure.",
		requires: "Named stages and known progression.",
	},
	loop: {
		fits: "A recurring cycle with a return path.",
		requires: "Stages and evidence that the cycle repeats.",
	},
	nested: {
		fits: "Objects contained within other objects.",
		requires: "Containers and contained items.",
	},
	layers: {
		fits: "An ordered stack of conceptual or technical layers.",
		requires: "Layers and their ordering.",
	},
	venn: { fits: "Overlap between sets.", requires: "Named sets and supported shared members." },
	pyramid: {
		fits: "Ranked or narrowing tiers.",
		requires: "Tier labels and their order or relative size.",
	},
	fishbone: {
		fits: "Causes grouped around an effect.",
		requires: "A stated effect and supported causes.",
	},
	kanban: { fits: "Work items grouped by workflow status.", requires: "Columns and item states." },
	"story-map": {
		fits: "Activities and tasks arranged across a journey.",
		requires: "Activities, tasks, and their ordering or grouping.",
	},
	quadrant: {
		fits: "Items classified on two meaningful axes.",
		requires: "Axis definitions and item positions.",
	},
	"dp-security-matrix": {
		fits: "Access relationships across data resources and roles.",
		requires: "Roles, resources, and permissions.",
	},
	bar: {
		fits: "Quantitative comparison across categories.",
		requires: "Categories and measured values.",
	},
	sankey: {
		fits: "Weighted flow among sources and destinations.",
		requires: "Nodes, flow links, and quantities.",
	},
	line: {
		fits: "Values changing across ordered observations.",
		requires: "Ordered x-values and measured y-values.",
	},
	scatter: {
		fits: "Relationship between paired numeric variables.",
		requires: "Numeric x/y pairs and axis meanings.",
	},
	radar: {
		fits: "Multiple comparable metrics for one or more items.",
		requires: "Metric axes and values on a shared scale.",
	},
	polar: {
		fits: "Values arranged around a circular dimension.",
		requires: "Angular categories or positions and values.",
	},
	waterfall: {
		fits: "Contributions that increase or decrease a total.",
		requires: "Starting value and signed contributions.",
	},
	treemap: {
		fits: "Part-to-whole quantities in a hierarchy.",
		requires: "Nested categories and nonnegative sizes.",
	},
	heatmap: {
		fits: "Numeric intensity across two dimensions.",
		requires: "Row/column categories and measured cell values.",
	},
	wardley: {
		fits: "Components positioned by user value and evolution.",
		requires: "Components, evolution positions, and dependencies.",
	},
};

export function visualChoices(): Record<string, string> {
	let choices: Record<string, string> = {};
	for (let [type, info] of Object.entries(DIAGRAM_TYPES)) {
		let description = VISUAL_DESCRIPTIONS[type];
		if (!description) throw new Error(`Missing visual description for ${type}`);
		choices[type] = `${info.name}: ${description.fits} Requires: ${description.requires}`;
	}
	choices.table =
		"Comparison table: alternatives under shared criteria. Requires: comparable rows and evidenced cells.";
	choices.none =
		"No supported visual type fits without inventing structure. Requires: prose explanation.";
	return choices;
}

export function visualExample(type: string): DiagramSpec | undefined {
	return DIAGRAM_FIXTURES.find(fixture => fixture.type === type)?.spec;
}
