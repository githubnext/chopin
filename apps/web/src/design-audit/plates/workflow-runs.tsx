import { RunStack } from "../../chat/run-card";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat } from "@chopin/protocol";

const RUN_STAGES: Chat.RunStage[] = [
	{
		id: "r:preflight",
		name: "preflight",
		kind: "tool",
		status: "completed",
		started: 1_000,
		ended: 1_002,
	},
	{ id: "r:draft-1", name: "draft-1", status: "completed", started: 1_002, ended: 1_380 },
	{ id: "r:reviewer-a-1", name: "reviewer-a-1", status: "completed", started: 1_380, ended: 1_620 },
	{ id: "r:draft-2", name: "draft-2", status: "running", started: 1_620 },
];

/** Fixture seconds are offsets; place them just before now so live durations read as minutes. */
let AUDIT_NOW = Math.floor(Date.now() / 1000);
let at = (offset: number) => AUDIT_NOW - 2_200 + offset;

function run(
	status: Chat.Run["status"],
	stages: Chat.RunStage[],
	{ name = "plan-review", started = 1_000, waiting = 0 }: {
		name?: string;
		started?: number;
		waiting?: number;
	} = {},
): Chat.Run {
	let ended = ["finished", "blocked", "failed", "stopped"].includes(status)
		? { ended: at(2_100) }
		: {};
	return {
		id: `audit-${name}-${status}`,
		name,
		status,
		started: at(started),
		updated: at(2_100),
		...ended,
		stages: stages.map(({ ended: stageEnded, ...stage }): Chat.RunStage => ({
			...stage,
			...(stage.started === undefined ? {} : { started: at(stage.started) }),
			...(stageEnded === undefined ? {} : { ended: at(stageEnded) }),
		})),
		waiting,
	};
}

const DONE_STAGES = RUN_STAGES.map(stage => ({
	...stage,
	status: "completed" as const,
	ended: stage.ended ?? 2_100,
}));

export function WorkflowRunsPlate() {
	return (
		<AuditPlate
			description="Planner-launched workflows: one live run, a concurrent stack ordered by who needs attention, and ended runs kept until the next run starts."
			item="workflow-runs"
			title="Workflow runs"
		>
			<div className="flex flex-col gap-2">
				<StateLabel>Running</StateLabel>
				<RunStack onPause={() => {}} runs={[run("running", RUN_STAGES)]} />
				<StateLabel>Concurrent</StateLabel>
				<RunStack
					onPause={() => {}}
					onResume={() => {}}
					onShowDecisions={() => {}}
					runs={[
						run("running", RUN_STAGES, { started: 1_400 }),
						run("finished", DONE_STAGES, { name: "docs-pass", started: 600 }),
						run("paused", [
							...RUN_STAGES.slice(0, 3),
							{ id: "r:draft-2", name: "draft-2", status: "paused", started: 1_620 },
						], { name: "api-audit", started: 1_200 }),
						run("waiting", [
							...RUN_STAGES.slice(0, 3),
							{ id: "r:draft-2", name: "draft-2", status: "awaiting_input", started: 1_620 },
						], { name: "review-b", started: 1_100, waiting: 2 }),
						run("blocked", DONE_STAGES, { name: "spec-check", started: 400 }),
					]}
				/>
				<StateLabel>Ended</StateLabel>
				<RunStack
					runs={[
						run("finished", DONE_STAGES),
						run("stopped", [
							{ id: "parent", name: "review", status: "stopped", started: 1_000, ended: 2_100 },
							{
								id: "active",
								name: "review-a",
								status: "running",
								started: 1_100,
								parentIds: ["parent"],
							},
							{ id: "queued", name: "review-b", status: "pending", parentIds: ["parent"] },
							{
								id: "done",
								name: "review-c",
								status: "completed",
								started: 1_100,
								ended: 1_200,
								parentIds: ["parent"],
							},
						], { name: "docs-pass", started: 500 }),
					]}
				/>
			</div>
		</AuditPlate>
	);
}
