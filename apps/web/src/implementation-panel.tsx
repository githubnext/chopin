import { useEffect, useState } from "react";
import { Badge } from "@chopin/visuals";
import { DocumentIcon } from "@chopin/icons";
import { ApiError } from "./api";
import { NavigationDialog } from "./navigation-dialog";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { Chat } from "@chopin/protocol";
import type { Wire } from "./wire";

async function response<T>(result: Response): Promise<T> {
	let value = await result.json();
	if (!result.ok) throw new ApiError(value.error ?? "Implementation is unavailable", result.status);
	return value;
}

export function ImplementationPanel({ id, canEdit, planner, wire, onClose }: {
	id: string;
	canEdit: boolean;
	planner: boolean;
	wire?: Wire;
	onClose: () => void;
}) {
	let [snapshot, setSnapshot] = useState<ImplementationSnapshot>();
	let [error, setError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let [workspace, setWorkspace] = useState("");
	let [refresh, setRefresh] = useState(0);
	let [reason, setReason] = useState("");
	let endpoint = `/api/channels/${encodeURIComponent(id)}/implementation`;
	useEffect(() => {
		let controller = new AbortController();
		let read = async () => {
			try {
				let value = await response<ImplementationSnapshot>(
					await fetch(endpoint, {
						signal: controller.signal,
						cache: "no-store",
					}),
				);
				if (!controller.signal.aborted) {
					setSnapshot(current => !current || value.revision >= current.revision ? value : current);
					setError(undefined);
				}
			} catch (reason) {
				if (!controller.signal.aborted) {
					setError(reason instanceof Error ? reason.message : "Connection failed");
				}
			}
		};
		void read();
		return () => controller.abort();
	}, [endpoint, refresh]);
	useEffect(() => {
		let reload = () => setRefresh(value => value + 1);
		let off = ["plan:implementation", "plan:open", "plan:update", "experiment:changed"]
			.map(kind => wire?.on(kind, reload));
		return () => off.forEach(remove => remove?.());
	}, [wire]);
	useEffect(() => {
		if (snapshot?.graph && location.hash.startsWith("#task-")) {
			document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "nearest" });
		}
	}, [snapshot?.graph?.number]);
	let active = snapshot?.lifecycle.execution.state === "active";
	let pending = snapshot?.build && ["queued", "starting", "running"].includes(snapshot.build.state);
	let available = snapshot?.workspaces.filter(item => item.available) ?? [];
	let selected = available.find(item => item.id === workspace) ?? available[0];
	let action = async (kind: "prepare" | "build" | "revise") => {
		if (!snapshot || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			if (kind === "prepare") {
				if (!wire?.connected) throw new Error("Chopin is disconnected");
				await wire.ask<Chat.Sent>("chat:send", {
					requestId: crypto.randomUUID(),
					to: "planner",
					text:
						"Prepare or revise the implementation graph for this settled plan. Read the current document and graph, then use edit_implementation_graph to create small reviewable tasks, acceptance criteria and explicit dependencies. Do not approve or start implementation.",
				});
			} else if (kind === "revise") {
				await response(
					await fetch(`${endpoint}/revise`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ buildId: snapshot.build?.id, reason }),
					}),
				);
				setReason("");
			} else {
				if (!selected || !snapshot.graph) {
					throw new Error("Review the tasks and connect your workspace first");
				}
				await response(
					await fetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							...(snapshot.build ? { retryOf: snapshot.build.id } : {}),
							connectionId: selected.id,
							checkout: selected.checkout,
							planRevision: snapshot.planRevision,
							graphVersion: snapshot.graph.number,
							graphRevision: snapshot.graph.revision,
						}),
					}),
				);
			}
			setRefresh(value => value + 1);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Build failed");
		} finally {
			setBusy(false);
		}
	};
	let history = snapshot?.lifecycle.history.findLast(item =>
		item.run.graphVersion === snapshot.graph?.number
		&& item.run.graphRevision === snapshot.graph?.revision
	);
	let activity = snapshot?.lifecycle.activity ?? history?.progress;
	let finished = history?.outcome.kind === "implemented" || history?.outcome.kind === "delivered";
	let stale = snapshot?.graph && snapshot.graph.planRevision !== snapshot.planRevision;
	let buildLabel =
		snapshot?.build?.state === "failed" || active && snapshot?.build?.state === "stopped"
			? "Needs attention"
			: history?.outcome.kind === "implemented" || history?.outcome.kind === "delivered"
			? "Implementation complete"
			: active
			? "Implementing"
			: snapshot?.build?.state === "queued"
			? "Waiting for local agent"
			: snapshot?.build?.state === "starting"
			? "Starting local agent"
			: snapshot?.build?.state === "running"
			? "Local agent connected"
			: snapshot?.build?.state === "stopped"
			? "Local agent stopped"
			: "Ready to review";
	let blockers = snapshot?.blockers ?? [];
	return (
		<NavigationDialog
			title="Implementation"
			motion={{ phase: "open", className: "is-open" }}
			onDismiss={onClose}
		>
			<section aria-label="Implementation" className="implementation-panel">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<strong className="text-sm">Reviewed tasks</strong>
						{snapshot?.build && <Badge size="sm" icon={DocumentIcon} label={buildLabel} />}
					</div>
					<div className="flex flex-wrap gap-2">
						<button className="btn btn-sm btn-ghost" onClick={() => setRefresh(value => value + 1)}>
							Refresh
						</button>
						{canEdit && !active && !pending && (
							<button
								className="btn btn-sm btn-outline"
								onClick={() => void action("prepare")}
								disabled={busy || !snapshot || !planner || blockers.length > 0}
							>
								{snapshot?.graph ? "Revise tasks" : "Prepare tasks"}
							</button>
						)}
						{canEdit && snapshot?.graph && !active && !pending && !finished && (
							<button
								className="btn btn-sm btn-primary"
								type="button"
								onClick={() => void action("build")}
								disabled={busy || blockers.length > 0 || !!stale || !selected}
							>
								{busy
									? "Starting…"
									: snapshot.build
									? "Retry build on my workspace"
									: "Approve and build this plan"}
							</button>
						)}
					</div>
				</div>
				{!snapshot && !error && <p role="status" className="text-sm">Loading implementation…</p>}
				{error && <p role="alert" className="m-0 mt-2 text-sm text-destructive-ink">{error}</p>}
				{stale && (
					<p className="m-0 mt-2 text-sm">
						The document changed. Revise the tasks before building.
					</p>
				)}
				{canEdit && active && !pending && (
					<form
						className="mt-3 flex flex-col gap-2"
						onSubmit={event => {
							event.preventDefault();
							void action("revise");
						}}
					>
						<p className="m-0 text-sm">
							Inspect the retained worktree before returning the plan for review.
						</p>
						<label className="text-sm">
							Reason for changes
							<textarea
								className="field mt-1 w-full"
								value={reason}
								onChange={event => setReason(event.target.value)}
								required
								maxLength={2000}
							/>
						</label>
						<button className="btn btn-md btn-outline" disabled={busy || !reason.trim()}>
							Return plan for changes
						</button>
					</form>
				)}
				{snapshot?.build?.error && <p className="m-0 mt-2 text-sm">{snapshot.build.error}</p>}
				{blockers.length > 0 && (
					<p className="m-0 mt-2 text-sm text-text-secondary">
						Resolve {blockers.join(" and ")} before building.
					</p>
				)}
				{snapshot?.graph && !active && !pending && !finished && (
					<p className="m-0 mt-2 text-sm text-text-secondary">
						{selected
							? `Build on ${selected.label} · ${selected.checkout.commit.slice(0, 8)}`
							: "Connect a workspace with the local connector to build this plan."}
					</p>
				)}
				{available.length > 1 && !active && !pending && !finished && (
					<select
						aria-label="Build on"
						value={selected?.id ?? ""}
						onChange={event => setWorkspace(event.target.value)}
					>
						{available.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
					</select>
				)}
				{snapshot?.graph && (
					<details className="mt-3" open>
						<summary className="text-sm cursor-pointer">
							{activity?.tasks.filter(task => task.state === "completed").length ?? 0} of{" "}
							{snapshot.graph.definition.tasks.length} tasks complete
						</summary>
						<ol className="implementation-tasks">
							{snapshot.graph.definition.tasks.map(task => {
								let progress = activity?.tasks.find(item => item.id === task.id);
								return (
									<li key={task.id} id={`task-${task.id}`}>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<strong className="text-sm">{task.title}</strong>
											<Badge
												size="sm"
												icon={DocumentIcon}
												label={progress?.state.replaceAll("_", " ") ?? "queued"}
											/>
										</div>
										<p className="m-0 mt-1 text-sm text-text-secondary">{task.goal}</p>
										{task.dependsOn.length > 0 && (
											<p className="m-0 mt-1 text-xs text-text-secondary">
												After {task.dependsOn.map(id =>
													snapshot.graph!.definition.tasks.find(item =>
														item.id === id
													)?.title ?? id
												).join(", ")}
											</p>
										)}
										<ul className="mt-1 mb-0 text-xs text-text-secondary">
											{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}
										</ul>
										{progress?.blocker && (
											<p className="m-0 mt-2 text-sm">Blocked: {progress.blocker}</p>
										)}
										{progress?.pullRequest && (
											<a
												className="text-sm"
												href={progress.pullRequest.url}
												target="_blank"
												rel="noreferrer"
											>
												Open pull request
											</a>
										)}
									</li>
								);
							})}
						</ol>
					</details>
				)}
				{snapshot?.build?.session && (
					<p className="m-0 mt-2 text-xs text-text-secondary">Session {snapshot.build.session}</p>
				)}
			</section>
			<button className="btn btn-md btn-ghost mt-3" onClick={onClose}>Close implementation</button>
		</NavigationDialog>
	);
}
