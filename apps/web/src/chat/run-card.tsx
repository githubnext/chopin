/** Planner-launched workflow runs: which are alive, which need someone, and how the last ones ended. */

import { useEffect, useState } from "react";
import { CheckIcon, ChevronIcon, CloseIcon, WarningIcon, WrenchIcon } from "@chopin/icons";

import plannerResume from "../assets/icons/planner-resume.svg";
import plannerStop from "../assets/icons/planner-stop.svg";

import type { Chat as Wire } from "@chopin/protocol";

const SHOWN_STAGES = 6;
const SHOWN_RUNS = 3;

const STATUS: Record<Wire.Run["status"], string> = {
	running: "running",
	waiting: "waiting on Decisions",
	paused: "paused",
	finished: "finished",
	blocked: "blocked",
	failed: "failed",
	stopped: "stopped",
};

const STAGE: Record<Wire.RunStage["status"], string> = {
	pending: "pending",
	running: "running",
	awaiting_input: "waiting on Decisions",
	paused: "paused",
	blocked: "blocked",
	completed: "done",
	failed: "failed",
	skipped: "skipped",
};

/** Waiting runs first, then running, paused, and ended; newest first within each. */
const GROUP: Record<Wire.Run["status"], number> = {
	waiting: 0,
	running: 1,
	paused: 2,
	finished: 3,
	blocked: 3,
	failed: 3,
	stopped: 3,
};

/** "45s", "6m", "1h 4m", "3d 4h". */
export function elapsed(seconds: number): string {
	let s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;
	let m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	let h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function orderRuns(runs: readonly Wire.Run[]): Wire.Run[] {
	return [...runs].sort((a, b) => GROUP[a.status] - GROUP[b.status] || b.started - a.started);
}

/** The run whose stages show without a click: the first one waiting on people, else the newest live one. */
export function defaultOpen(ordered: readonly Wire.Run[]): string | undefined {
	return ordered.find(run => run.status === "waiting")?.id
		?? ordered.find(run => run.status === "running")?.id;
}

/** The rows shown before "more": at least the first few, and never fewer than every waiting run. */
export function visibleRuns(ordered: readonly Wire.Run[], showAll: boolean): Wire.Run[] {
	if (showAll) return [...ordered];
	let waiting = ordered.filter(run => run.status === "waiting").length;
	return ordered.slice(0, Math.max(SHOWN_RUNS, waiting));
}

function useNow(live: boolean): number {
	let [now, setNow] = useState(() => Date.now() / 1000);
	useEffect(() => {
		if (!live) return;
		let timer = setInterval(() => setNow(Date.now() / 1000), 5_000);
		return () => clearInterval(timer);
	}, [live]);
	return now;
}

/** A dot that pulses while work is live; it stays still under reduced motion. */
function RunPulse() {
	return <span aria-hidden="true" className="run-pulse" data-run-pulse="" />;
}

/** A hollow ring for work that is pending, paused, or was stopped. */
function RunRing() {
	return <span aria-hidden="true" className="run-ring" />;
}

function RunGlyph({ status }: { status: Wire.Run["status"] }) {
	if (status === "running") return <RunPulse />;
	if (status === "waiting") {
		return <WarningIcon aria-hidden="true" className="text-warning-ink" size={14} />;
	}
	if (status === "finished") {
		return <CheckIcon aria-hidden="true" className="text-success-ink" size={14} />;
	}
	if (status === "failed" || status === "blocked") {
		return <CloseIcon aria-hidden="true" className="text-destructive-ink" size={14} />;
	}
	return <RunRing />;
}

function StageGlyph({ status }: { status: Wire.RunStage["status"] }) {
	if (status === "running") return <RunPulse />;
	if (status === "completed") {
		return <CheckIcon aria-hidden="true" className="text-success-ink" size={14} />;
	}
	if (status === "failed" || status === "blocked") {
		return <CloseIcon aria-hidden="true" className="text-destructive-ink" size={14} />;
	}
	if (status === "awaiting_input") {
		return <WarningIcon aria-hidden="true" className="text-warning-ink" size={14} />;
	}
	return <RunRing />;
}

type RunControls = {
	onShowDecisions?: () => void;
	onPause?: (runId: string) => void;
	onResume?: (runId: string) => void;
};

function RunRow({ run, tag, open, onToggle, onShowDecisions, onPause, onResume }: RunControls & {
	run: Wire.Run;
	/** Tells apart runs of the same workflow. */
	tag?: string;
	open: boolean;
	onToggle: () => void;
}) {
	let live = run.status === "running" || run.status === "waiting";
	let now = useNow(live);
	let end = run.ended ?? (live ? now : run.updated);
	let hidden = Math.max(0, run.stages.length - SHOWN_STAGES);
	let stages = run.stages.slice(hidden);
	let earlier = hidden + (run.earlierStages ?? 0);
	let stagesId = `run-stages-${run.id}`;
	let title = tag ? `${run.name} ${tag}` : run.name;
	let control = live && onPause
		? { label: `Pause ${title}`, icon: plannerStop, act: () => onPause(run.id), kind: "pause" }
		: run.status === "paused" && onResume
		? {
			label: `Resume ${title}`,
			icon: plannerResume,
			act: () => onResume(run.id),
			kind: "resume",
		}
		: undefined;

	return (
		<li className="run-row" data-run-status={run.status}>
			<div className="flex min-w-0 items-center gap-1">
				<button
					aria-controls={stagesId}
					aria-expanded={open}
					aria-label={`${title}, ${STATUS[run.status]}, ${elapsed(end - run.started)}`}
					className="run-toggle"
					data-run-toggle=""
					onClick={onToggle}
					type="button"
				>
					<RunGlyph status={run.status} />
					<span className="min-w-0 truncate font-mono text-text-secondary">{run.name}</span>
					{tag && (
						<span className="shrink-0 font-mono text-text-quaternary tabular-nums">{tag}</span>
					)}
					<span
						aria-live="polite"
						className={`shrink-0 ${
							run.status === "waiting" ? "text-warning-ink" : "text-text-tertiary"
						}`}
					>
						{STATUS[run.status]}
					</span>
					<span className="ml-auto shrink-0 text-text-quaternary tabular-nums">
						{elapsed(end - run.started)}
					</span>
					<ChevronIcon
						aria-hidden="true"
						className="run-chevron shrink-0 text-text-quaternary"
						size={14}
					/>
				</button>
				{control && (
					<button
						aria-label={control.label}
						className="btn btn-icon btn-secondary shrink-0"
						data-run-control={control.kind}
						onClick={control.act}
						title={control.label}
						type="button"
					>
						<img alt="" className="size-[14px]" src={control.icon} />
					</button>
				)}
			</div>
			{open && (
				<div className="pb-1 pl-[22px]" id={stagesId}>
					<ol className="flex flex-col gap-0.5">
						{earlier > 0 && (
							<li className="text-text-quaternary tabular-nums">+{earlier} earlier</li>
						)}
						{stages.map(stage => (
							<li
								className={`flex min-w-0 items-center gap-2 ${
									stage.status === "completed" || stage.status === "skipped"
										? "text-text-quaternary"
										: ""
								}`}
								data-run-stage={stage.status}
								key={stage.id}
							>
								<StageGlyph status={stage.status} />
								{stage.kind === "tool" && (
									<WrenchIcon
										aria-hidden="true"
										className="shrink-0 text-text-quaternary"
										size={14}
									/>
								)}
								<span className="min-w-0 truncate font-mono">
									{stage.kind === "tool" && <span className="sr-only">{"tool step: "}</span>}
									{stage.name}
								</span>
								<span
									className={`shrink-0 ${
										stage.status === "awaiting_input" ? "text-warning-ink" : "text-text-tertiary"
									}`}
								>
									{STAGE[stage.status]}
								</span>
								{stage.started !== undefined && (
									<span className="ml-auto shrink-0 text-text-quaternary tabular-nums">
										{elapsed((stage.ended ?? (live ? now : run.updated)) - stage.started)}
									</span>
								)}
							</li>
						))}
					</ol>
				</div>
			)}
			{run.waiting > 0 && (
				<button
					className="btn btn-sm btn-ghost -ml-2 mb-1 text-warning-ink"
					data-run-waiting={run.waiting}
					onClick={onShowDecisions}
					type="button"
				>
					Waiting on {run.waiting} {run.waiting === 1 ? "Decision" : "Decisions"}
				</button>
			)}
		</li>
	);
}

export function RunStack(
	{ runs, onShowDecisions, onPause, onResume }: RunControls & { runs: readonly Wire.Run[] },
) {
	let [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
	let [showAll, setShowAll] = useState(false);
	let ordered = orderRuns(runs);
	let named = new Map<string, number>();
	for (let run of runs) named.set(run.name, (named.get(run.name) ?? 0) + 1);
	let fallback = defaultOpen(ordered);
	let shown = visibleRuns(ordered, showAll);
	let folded = ordered.length - visibleRuns(ordered, false).length;

	return (
		<section
			aria-label="Workflow runs"
			className="rounded-lg bg-page px-3 text-sm ring-hairline"
			data-run-stack=""
		>
			<ol className="flex flex-col">
				{shown.map(run => {
					let open = chosen.get(run.id) ?? run.id === fallback;
					return (
						<RunRow
							key={run.id}
							onPause={onPause}
							onResume={onResume}
							onShowDecisions={onShowDecisions}
							tag={(named.get(run.name) ?? 0) > 1 ? run.id.slice(0, 8) : undefined}
							onToggle={() => setChosen(previous => new Map(previous).set(run.id, !open))}
							open={open}
							run={run}
						/>
					);
				})}
			</ol>
			{folded > 0 && (
				<button
					aria-expanded={showAll}
					className="btn btn-sm btn-ghost -ml-2 mb-1 text-text-tertiary tabular-nums"
					data-run-more=""
					onClick={() => setShowAll(all => !all)}
					type="button"
				>
					{showAll ? "Show fewer" : `+${folded} more`}
				</button>
			)}
		</section>
	);
}
