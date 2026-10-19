import type { ConversationPlan } from "@chopin/protocol";
import { CHILD_TOOLS, INVESTIGATION_READS, WRITE_TOOLS } from "../agent/job-scope";

export const PLANNER_TOOL_NAMES = [
	"list_investigations",
	"read_investigation",
	"propose_investigation",
	"set_investigation_build_blocker",
	"read_plan",
	"read_reference",
	"list_background_jobs",
	"read_background_job",
	"create_research_workspace",
	"edit_plan",
	"open_decision",
	"open_decisions",
	"ask",
	"read_implementation_graph",
	"edit_implementation_graph",
	"anchor_plan",
	"reply_comment",
	"list_children",
	"read_child",
	"edit_child",
	"anchor_child",
	"read_repository_file",
	"list_repository_tree",
	"search_repository",
	"repository_history",
	"list_pull_requests",
	"pull_request_read",
	"revise_open_decision",
];

export const VISUAL_PLANNER_TOOL_NAMES = Object.freeze([
	...PLANNER_TOOL_NAMES,
	"assess_visual",
]);

function jobNames(own: string): readonly string[] {
	return Object.freeze([
		...PLANNER_TOOL_NAMES.filter(name =>
			!WRITE_TOOLS.has(name) && !INVESTIGATION_READS.has(name) && !CHILD_TOOLS.has(name)
		),
		own,
	]);
}

export const BACKGROUND_TOOL_NAMES: Readonly<Record<ConversationPlan.JobKind, readonly string[]>> =
	Object.freeze({
		heading: jobNames("draft_heading"),
		refine: jobNames("refine_decision"),
		suggest: jobNames("refine_decision"),
		prose: jobNames("write_decision_prose"),
		"decision-followup": Object.freeze([
			...jobNames("write_decision_scope"),
			"read_decision_scope",
		]),
	});

export const HEADING_TOOL_NAMES = BACKGROUND_TOOL_NAMES.heading;
