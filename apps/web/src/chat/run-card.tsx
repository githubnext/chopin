/** A Planner-launched workflow run: is it alive, what is it doing, does it need anyone. */

import { useEffect, useState } from "react";
import { CheckIcon, CloseIcon, WarningIcon } from "@chopin/icons";

import type { Chat as Wire } from "@chopin/protocol";

const SHOWN_STAGES = 6;

const STATUS: Record<Wire.Run["status"], string> = {
	running: "running",
	waiting: "waiting on Decisions",
	paused: "paused",
	finished: "finished",
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

/** "45s", "6m", "1h 4m". */
export function elapsed(seconds: number): string {
	let s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;
	let m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
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

function StageGlyph({ status }: { status: Wire.RunStage["status"] }) {
	if (status === "running") {
		return <RunPulse />;
	}
	if (status === "completed") {
		return <CheckIcon aria-hidden="true" className="text-success-ink" size={14} />;
	}
	if (status === "failed" || status === "blocked") {
		return <CloseIcon aria-hidden="true" className="text-destructive-ink" size={14} />;
	}
	if (status === "awaiting_input") {
		return <WarningIcon aria-hidden="true" className="text-warning-ink" size={14} />;
	}
	return (
		<span aria-hidden="true" className="inline-block size-[14px] text-center leading-[14px]">
			○
		</span>
	);
}

export function RunCard({ run, onShowDecisions }: { run: Wire.Run; onShowDecisions?: () => void }) {
	let live = run.status === "running" || run.status === "waiting";
	let now = useNow(live);
	let end = run.ended ?? (live ? now : run.updated);
	let hidden = Math.max(0, run.stages.length - SHOWN_STAGES);
	let stages = run.stages.slice(hidden);

	return (
		<section
			aria-label={`Workflow ${run.name}`}
			className="rounded-lg bg-page px-3 py-2 text-sm ring-hairline"
			data-run-status={run.status}
		>
			<div className="flex min-w-0 items-center gap-2">
				{live
					? <RunPulse />
					: <span aria-hidden="true" className="inline-block size-[14px]" />}
				<span className="min-w-0 truncate font-mono text-text-secondary">{run.name}</span>
				<span
					aria-live="polite"
					className={run.status === "waiting" ? "text-warning-ink" : "text-text-tertiary"}
				>
					{STATUS[run.status]}
				</span>
				<span className="ml-auto shrink-0 text-text-quaternary tabular-nums">
					{elapsed(end - run.started)}
				</span>
			</div>
			<ol className="mt-1 flex flex-col gap-0.5">
				{hidden > 0 && <li className="pl-6 text-text-quaternary tabular-nums">+{hidden} earlier
				</li>}
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
						<span className="min-w-0 truncate font-mono">{stage.name}</span>
						<span
							className={stage.status === "awaiting_input"
								? "text-warning-ink"
								: "text-text-tertiary"}
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
			{run.waiting > 0 && (
				<button
					className="btn btn-sm btn-ghost mt-1 -ml-2 text-warning-ink"
					data-run-waiting={run.waiting}
					onClick={onShowDecisions}
					type="button"
				>
					Waiting on {run.waiting} {run.waiting === 1 ? "Decision" : "Decisions"}
				</button>
			)}
		</section>
	);
}
