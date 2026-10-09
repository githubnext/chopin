import { useEffect, useState } from "react";
import { Badge } from "@chopin/visuals";
import { DocumentIcon } from "@chopin/icons";
import { ApiError } from "./api";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { Chat } from "@chopin/protocol";
import type { Wire } from "./wire";

async function response<T>(result: Response): Promise<T> {
	let value = await result.json();
	if (!result.ok) throw new ApiError(value.error ?? "Implementation is unavailable", result.status);
	return value;
}

export function ImplementationPanel({ id, canEdit, planner, wire, onLocked }: {
	id: string;
	canEdit: boolean;
	planner: boolean;
	wire?: Wire;
	onLocked: (locked: boolean) => void;
}) {
	let [snapshot, setSnapshot] = useState<ImplementationSnapshot>();
	let [error, setError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let [workspace, setWorkspace] = useState("");
	let endpoint = `/api/channels/${encodeURIComponent(id)}/implementation`;
	useEffect(() => {
		let controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let read = async () => {
			try {
				let value = await response<ImplementationSnapshot>(
					await fetch(endpoint, {
						signal: controller.signal,
						cache: "no-store",
					}),
				);
				if (!controller.signal.aborted) {
					setSnapshot(value);
				}
			} catch (reason) {
				if (!controller.signal.aborted) {
					setError(reason instanceof Error ? reason.message : "Connection failed");
				}
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(() => void read(), 2000);
			}
		};
		void read();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [endpoint]);
	let active = snapshot?.lifecycle.execution.state === "active";
	let pending = snapshot?.build && ["queued", "starting", "running"].includes(snapshot.build.state);
	useEffect(() => {
		onLocked(!!active || !!pending);
	}, [active, pending, onLocked]);
	let available = snapshot?.workspaces.filter(item => item.available) ?? [];
	let selected = available.find(item => item.id === workspace) ?? available[0];
	let action = async () => {
		if (!snapshot || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			if (!snapshot.graph) {
				if (!wire?.connected) throw new Error("Chopin is disconnected");
				await wire.ask<Chat.Sent>("chat:send", {
					requestId: crypto.randomUUID(),
					to: "planner",
					text:
						"Prepare an implementation graph for this settled plan. Read the current document and graph, then use edit_implementation_graph to create small reviewable tasks, acceptance criteria and explicit dependencies. Do not approve or start implementation.",
				});
			} else {
				if (!selected) throw new Error("Connect your local workspace first");
				let build = await response<NonNullable<ImplementationSnapshot["build"]>>(
					await fetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							connectionId: selected.id,
							checkout: selected.checkout,
							planRevision: snapshot.planRevision,
							graphVersion: snapshot.graph.number,
							graphRevision: snapshot.graph.revision,
						}),
					}),
				);
				setSnapshot({ ...snapshot, build });
			}
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
		<section aria-label="Implementation" className="implementation-panel">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<strong className="text-sm">Implementation</strong>
					{snapshot?.build && <Badge size="sm" icon={DocumentIcon} label={buildLabel} />}
				</div>
				{canEdit && !snapshot?.build && (
					<button
						className="btn btn-sm btn-outline"
						type="button"
						onClick={() => void action()}
						disabled={busy || !snapshot || blockers.length > 0 || !snapshot.graph && !planner
							|| !!snapshot.graph && !selected}
					>
						{busy
							? "Preparing…"
							: snapshot?.graph
							? "Approve and build this plan"
							: "Prepare tasks"}
					</button>
				)}
			</div>
			{error && <p role="alert" className="m-0 mt-2 text-sm text-danger-text">{error}</p>}
			{snapshot?.build?.error && <p className="m-0 mt-2 text-sm">{snapshot.build.error}</p>}
			{blockers.length > 0 && (
				<p className="m-0 mt-2 text-sm text-text-secondary">
					Resolve {blockers.join(" and ")} before building.
				</p>
			)}
			{snapshot?.graph && !snapshot.build && (
				<p className="m-0 mt-2 text-sm text-text-secondary">
					{selected
						? `Build on ${selected.label} · ${selected.checkout.commit.slice(0, 8)}`
						: "Connect a workspace with the local connector to build this plan."}
				</p>
			)}
			{(available.length) > 1 && !snapshot?.build && (
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
											After{" "}
											{task.dependsOn.map(id =>
												snapshot.graph!.definition.tasks.find(item => item.id === id)?.title ?? id
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
	);
}
