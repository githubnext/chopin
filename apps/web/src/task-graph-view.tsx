import { useMemo } from "react";
import { Diagram } from "@chopin/diagrams/react";
import "@chopin/diagrams/styles.css";

import { GRAPH_TASK_STATE, taskGraphModel } from "./task-graph-model";
import { pullRequestNumber } from "./build-model";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { GraphTask } from "./task-graph-model";

export function TaskGraphView({ snapshot, room }: {
	snapshot: ImplementationSnapshot;
	room: string;
}) {
	let model = useMemo(() => taskGraphModel(snapshot), [snapshot]);
	let graph = snapshot.graph;
	if (!graph) return null;
	let detail = (task: GraphTask) => {
		let report = model.reports.get(task.id);
		let state = GRAPH_TASK_STATE[report?.state ?? "queued"];
		let waiting = task.dependsOn.filter(id => model.reports.get(id)?.state !== "completed")
			.map(id => graph.definition.tasks.find(task => task.id === id)?.title ?? id);
		return (
			<div className="task-graph-detail">
				<p className="task-graph-state" data-tone={state.tone}>{state.badge}</p>
				<p>{task.context}</p>
				<p>{task.goal}</p>
				<h4>Acceptance criteria</h4>
				<ul>{task.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
				{report?.state !== "completed" && waiting.length > 0 && (
					<p>Waiting for: {waiting.join(", ")}</p>
				)}
				{report?.blocker && <p className="build-task-blocker">Blocked: {report.blocker}</p>}
				{report?.summary && <p>{report.summary}</p>}
				{report?.pullRequest && (
					<a
						className="build-task-pr"
						data-state={report.pullRequest.state}
						href={report.pullRequest.url}
						rel="noreferrer"
						target="_blank"
					>
						Pull request #{pullRequestNumber(report.pullRequest.url)} · {report.pullRequest.state}
					</a>
				)}
			</div>
		);
	};
	return (
		<div className="task-graph">
			<p aria-live="polite" className="task-graph-progress">
				{model.completed} of {graph.definition.tasks.length} tasks complete
				{model.blocked > 0 ? ` · ${model.blocked} blocked` : ""}
			</p>
			{model.stale && (
				<p className="build-note" role="status">
					Out of date · The document changed since these tasks were drafted. Open Build to update
					tasks.
				</p>
			)}
			<Diagram
				spec={model.spec}
				stateKey={`${room}:${graph.number}:${graph.revision}:${graph.planRevision}`}
				title="Task dependencies"
				description="Arrows connect prerequisites to dependent tasks. Select a task to inspect its details and progress."
				nodePresentation={model.presentation}
				renderNodeDetails={id => {
					let task = model.byNode.get(id);
					return task && detail(task);
				}}
				fallback={
					<>
						<p role="status">
							This graph exceeds the diagram’s display limits. All tasks are listed below.
						</p>
						<ul className="task-graph-fallback" aria-label="Tasks">
							{graph.definition.tasks.map(task => (
								<li key={task.id}>
									<h3>{task.title}</h3>
									{detail(task)}
									{task.dependsOn.length > 0 && (
										<p>
											After{" "}
											{task.dependsOn.map(id =>
												graph.definition.tasks.find(task => task.id === id)?.title ?? id
											).join(", ")}
										</p>
									)}
								</li>
							))}
						</ul>
					</>
				}
			/>
			{model.progress?.verification && (
				<details className="task-graph-verification">
					<summary>
						Verification {model.progress.verification.passed ? "passed" : "needs work"}
					</summary>
					<p>{model.progress.verification.summary}</p>
					<p>{model.progress.verification.reviewerMethod}</p>
					<ul>
						{model.progress.verification.evidence.map(entry => (
							<li key={entry.taskId}>
								{graph.definition.tasks.find(task => task.id === entry.taskId)?.title
									?? entry.taskId}
								<ul>{entry.evidence.map((text, index) => <li key={index}>{text}</li>)}</ul>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
