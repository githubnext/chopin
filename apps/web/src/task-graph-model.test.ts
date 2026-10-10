import { expect, test } from "bun:test";
import { renderDiagram } from "@chopin/diagrams";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

import { taskGraphModel } from "./task-graph-model";

function snapshot(): ImplementationSnapshot {
	return {
		revision: 1,
		planRevision: 2,
		graph: {
			number: 1,
			revision: 1,
			planRevision: 2,
			state: "draft",
			definition: {
				tasks: ["1 / setup", "1--setup", "検証"].map((id, index) => ({
					id,
					title: index === 0
						? "An unusually long task title that needs more than forty characters"
						: id,
					context: "Repository context",
					goal: "Complete this task",
					acceptance: ["Works", "Verified"],
					dependsOn: index === 2 ? ["1 / setup", "1--setup", "1 / setup"] : [],
				})),
			},
		},
		workspaces: [],
		blockers: [],
		lifecycle: { execution: { state: "idle" }, history: [] },
	};
}

test("projects opaque IDs and long titles into valid nodes with prerequisite-to-dependent edges", () => {
	let source = snapshot();
	let model = taskGraphModel(source);
	let drawing = renderDiagram(model.spec);
	expect(drawing.ok).toBe(true);
	if (!drawing.ok) return;
	expect(drawing.graph?.nodes).toHaveLength(3);
	expect(drawing.graph?.edges.map(edge => [edge.from, edge.to])).toEqual([
		["task_0", "task_2"],
		["task_1", "task_2"],
	]);
	expect(model.byNode.get("task_0")?.id).toBe("1 / setup");
	expect(model.presentation.get("task_0")?.label).toBe(source.graph!.definition.tasks[0].title);
	expect(drawing.graph?.nodes[0].label.length).toBeLessThanOrEqual(40);
	for (let state of ["queued", "in_progress", "blocked", "completed"] as const) {
		source.lifecycle.activity = { tasks: [{ id: "1 / setup", state }], events: [] };
		expect(renderDiagram(taskGraphModel(source).spec).ok).toBe(true);
	}
});

test("distinguishes completion from verification and uses only this graph's history", () => {
	let source = snapshot();
	source.graph!.state = "locked";
	source.lifecycle = {
		execution: { state: "active" },
		activity: {
			tasks: source.graph!.definition.tasks.map(task => ({ id: task.id, state: "completed" })),
			events: [],
		},
		history: [],
	};
	expect(taskGraphModel(source).label).toBe("Awaiting verification");
	let progress = source.lifecycle.activity!;
	source.lifecycle = {
		execution: { state: "idle" },
		history: [{
			run: {
				id: "run",
				user: "ana",
				client: { name: "local", version: "1" },
				session: "session",
				planRevision: 2,
				graphVersion: 1,
				graphRevision: 1,
				repository: "o/r",
				branch: "main",
				commit: "a".repeat(40),
				startedAt: "2026-10-10T10:00:00Z",
			},
			progress,
			outcome: { kind: "implemented" },
		}],
	};
	expect(taskGraphModel(source).label).toBe("Verified");
	expect(taskGraphModel(source).completed).toBe(3);
	source.graph!.revision++;
	expect(taskGraphModel(source).completed).toBe(0);
	expect(taskGraphModel(source).label).toBe("Ready for review");
	source.graph!.revision--;
	source.graph!.planRevision++;
	expect(taskGraphModel(source).completed).toBe(0);
	expect(taskGraphModel(source).stale).toBe(true);
});

test("retains every task when the graph exceeds rendering bounds", () => {
	let source = snapshot();
	let task = source.graph!.definition.tasks[0];
	source.graph!.definition.tasks = Array.from(
		{ length: 201 },
		(_, index) => ({ ...task, id: String(index) }),
	);
	let model = taskGraphModel(source);
	expect(renderDiagram(model.spec).ok).toBe(false);
	expect(model.byNode.size).toBe(201);
});
