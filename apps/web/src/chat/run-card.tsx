/** The document's running build, as Chat shows it under the transcript while it runs. */

import { useEffect, useState } from "react";
import { ChevronIcon } from "@chopin/icons";

import "./run-row.css";

import type { BuildRun } from "../build-model";

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

/** A hollow ring for work that is waiting to start. */
function RunRing() {
	return <span aria-hidden="true" className="run-ring" />;
}

/** `#12` for a pull request link, else nothing. */
function pullNumber(url: string): string | undefined {
	return url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1];
}

/**
 * The document's running build: what it is on, what its agent is doing, and the pull requests it
 * has opened, with the way into Build. It goes when the build ends; Chat's line about how it ended
 * stays.
 */
function BuildRunRow(
	{ build, open, onToggle, onShowBuild }: {
		build: BuildRun;
		open: boolean;
		onToggle: () => void;
		onShowBuild?: () => void;
	},
) {
	let now = useNow(true);
	let started = Date.parse(build.started) / 1000;
	let since = elapsed(now - (Number.isFinite(started) ? started : now));
	let title = build.kind === "rebuild" ? "Building changes" : "Build";
	let status = build.state === "queued"
		? "queued"
		: build.kind === "rebuild" || !build.total
		? "running"
		: `${build.done} of ${build.total} tasks`;
	let detailId = `build-run-${build.id}`;
	let links = build.pullRequests.flatMap(url => {
		let number = pullNumber(url);
		return number ? [{ url, number }] : [];
	});
	return (
		<li className="run-row" data-build-run={build.state} data-run-status="running">
			<div className="run-head flex min-w-0 items-center gap-1">
				<button
					aria-controls={detailId}
					aria-expanded={open}
					aria-label={`${title}, ${status}, ${since}`}
					className="run-toggle"
					data-run-toggle=""
					onClick={onToggle}
					type="button"
				>
					{build.state === "queued" ? <RunRing /> : <RunPulse />}
					<span className="min-w-0 truncate text-text-secondary">{title}</span>
					<span aria-live="polite" className="shrink-0 text-text-tertiary tabular-nums">
						{status}
					</span>
					<span className="ml-auto shrink-0 text-text-quaternary tabular-nums">{since}</span>
					<ChevronIcon
						aria-hidden="true"
						className="run-chevron shrink-0 text-text-quaternary"
						size={16}
					/>
				</button>
			</div>
			{open && (
				<div className="flex min-w-0 flex-col pb-1 pl-[22px]" id={detailId}>
					{build.task && (
						<p className="truncate text-text-secondary" data-build-run-task="">{build.task}</p>
					)}
					{build.activity && (
						<p className="truncate text-text-tertiary" data-build-run-activity="">
							{build.activity}
						</p>
					)}
					<div className="flex min-w-0 flex-wrap items-center gap-x-2">
						{links.map(link => (
							<a
								aria-label={`Pull request #${link.number}`}
								className="link tabular-nums"
								href={link.url}
								key={link.url}
								rel="noreferrer"
								target="_blank"
							>
								#{link.number}
							</a>
						))}
						{onShowBuild && (
							<button
								className="btn btn-sm btn-ghost -ml-2 text-text-tertiary"
								data-build-run-open=""
								onClick={onShowBuild}
								type="button"
							>
								Open Build
							</button>
						)}
					</div>
				</div>
			)}
		</li>
	);
}

/** The card of the document's running build, under Chat's transcript while it runs. */
export function BuildCard(
	{ build, onShowBuild }: { build: BuildRun; onShowBuild?: () => void },
) {
	let [open, setOpen] = useState(true);
	return (
		<section
			aria-label="Running build"
			className="run-stack rounded-lg bg-page px-3 text-sm ring-hairline"
			data-run-stack=""
		>
			<ol className="flex flex-col">
				<BuildRunRow
					build={build}
					onShowBuild={onShowBuild}
					onToggle={() => setOpen(value => !value)}
					open={open}
				/>
			</ol>
		</section>
	);
}
