import type { DiagramSpec } from "@chopin/diagrams";
import type { DiagramProps } from "@chopin/diagrams/react";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

import { buildPhase, buildProgress } from "./build-model";
import type { TaskState } from "./build-model";

export type GraphTask = NonNullable<ImplementationSnapshot["graph"]>["definition"]["tasks"][number];

export const GRAPH_TASK_STATE: Record<TaskState, {
	label: string;
	badge: string;
	tone: "neutral" | "active" | "warning" | "success";
}> = {
	queued: { label: "Queued", badge: "○ Queued", tone: "neutral" },
	in_progress: { label: "In progress", badge: "▶ In progress", tone: "active" },
	blocked: { label: "Blocked", badge: "! Blocked", tone: "warning" },
	completed: { label: "Completed", badge: "✓ Completed", tone: "success" },
};

export function taskGraphModel(snapshot: ImplementationSnapshot) {
	let tasks = snapshot.graph?.definition.tasks ?? [];
	let progress = buildProgress(snapshot);
	let reports = new Map(progress?.tasks.map(task => [task.id, task]));
	// Task IDs are opaque. Renderer IDs are bounded identifiers, local to this definition.
	let ids = new Map(tasks.map((task, index) => [task.id, `task_${index}`]));
	let byNode = new Map(tasks.map(task => [ids.get(task.id)!, task]));
	let presentation: NonNullable<DiagramProps["nodePresentation"]> = new Map(tasks.map(task => {
		let state = GRAPH_TASK_STATE[reports.get(task.id)?.state ?? "queued"];
		return [ids.get(task.id)!, { label: task.title, description: state.label, tone: state.tone }];
	}));
	let spec: DiagramSpec = {
		type: "dependency",
		title: "Task graph",
		dir: "TB",
		motion: "none",
		legend: false,
		budget: "off",
		nodes: tasks.map(task => ({
			id: ids.get(task.id)!,
			label: task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title,
			tag: GRAPH_TASK_STATE[reports.get(task.id)?.state ?? "queued"].badge,
		})),
		edges: tasks.flatMap(task =>
			[...new Set(task.dependsOn)].map(id => [ids.get(id), ids.get(task.id)])
		),
	};
	let completed = tasks.filter(task => reports.get(task.id)?.state === "completed").length;
	let blocked = tasks.filter(task => reports.get(task.id)?.state === "blocked").length;
	let phase = buildPhase(snapshot);
	let label = phase.kind === "done"
		? "Verified"
		: phase.kind === "stopped"
		? "Implementation stopped"
		: phase.kind === "failed"
		? "Startup failed"
		: phase.kind === "building"
		? snapshot.build?.state === "queued"
			? "Queued"
			: snapshot.build?.state === "starting"
			? "Starting"
			: tasks.length > 0 && completed === tasks.length
			? "Awaiting verification"
			: "Implementing"
		: phase.kind === "drafting" && phase.draft === "returned"
		? "Returned for changes"
		: phase.kind === "blocked"
		? "Planning updates needed"
		: "Ready for review";
	return {
		spec,
		byNode,
		presentation,
		reports,
		progress,
		label,
		completed,
		blocked,
		stale: !!snapshot.graph && snapshot.graph.planRevision !== snapshot.planRevision,
	};
}
