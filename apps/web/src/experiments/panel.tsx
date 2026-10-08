import { useEffect, useState, useSyncExternalStore } from "react";
import { ExperimentView } from "@chopin/experiment/react";
import { StaticPlanEditor } from "@chopin/editor/static";
import { NavigationDialog } from "../navigation-dialog";
import type { ExperimentStore } from "./store";

export function ExperimentsPanel({ store, userId, canEdit, onClose }: {
	store: ExperimentStore;
	userId: string;
	canEdit: boolean;
	onClose: () => void;
}) {
	useSyncExternalStore(store.subscribe, store.snapshot);
	let [selected, setSelected] = useState("");
	let [brief, setBrief] = useState("");
	let [connectionId, setConnectionId] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let item = store.get(selected);
	let owned = store.connections.filter(connection => connection.owner === userId);
	useEffect(() => {
		if (selected) void store.load(selected);
	}, [store, selected]);
	async function act(action: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (error) {
			setError(String((error as Error).message));
		} finally {
			setBusy(false);
		}
	}
	return (
		<NavigationDialog
			title="Investigations"
			motion={{ phase: "open", className: "" }}
			onDismiss={onClose}
		>
			<div className="flex max-h-[75vh] min-w-0 flex-col gap-4 overflow-auto">
				<p className="text-sm text-text-secondary">
					{store.connections.length
						? store.connections.map(connection =>
							`${connection.login}: ${connection.label} (${connection.source.commit.slice(0, 8)})`
						).join(" · ")
						: "Connect a local workspace with chopin connect to run an investigation."}
				</p>
				{(error || store.error) && (
					<p role="alert" className="text-sm text-destructive-ink">{error || store.error}</p>
				)}
				{canEdit && (
					<form
						className="flex flex-col gap-2"
						onSubmit={event => {
							event.preventDefault();
							void act(async () => {
								let value = await store.action("", "", { id: crypto.randomUUID(), brief });
								setSelected(value.id);
								setBrief("");
							});
						}}
					>
						<label className="text-sm">
							Investigation brief<textarea
								aria-label="Investigation brief"
								className="mt-1 w-full rounded-md border p-2 text-sm"
								value={brief}
								maxLength={8000}
								onChange={event => setBrief(event.target.value)}
							/>
						</label>
						<button className="btn btn-primary" disabled={busy || !brief.trim()}>
							Propose investigation
						</button>
					</form>
				)}
				<label className="text-sm">
					Investigation<select
						aria-label="Investigation"
						className="ml-2 rounded-md border p-2"
						value={selected}
						onChange={event => setSelected(event.target.value)}
					>
						<option value="">Choose an investigation</option>
						{store.items.map(value => (
							<option key={value.id} value={value.id}>
								{value.brief.slice(0, 100)} · {value.state}
							</option>
						))}
					</select>
				</label>
				{item && (
					<>
						<p className="text-sm">{item.brief}</p>
						<p role="status" className="text-xs text-text-secondary">
							{item.state} {item.progress && `· ${item.progress}`}
						</p>
						{canEdit && item.state === "requested" && (
							<div className="flex flex-wrap gap-2">
								<select
									aria-label="Your workspace"
									className="rounded-md border p-2 text-sm"
									value={connectionId || (owned.length === 1 ? owned[0].id : "")}
									onChange={event => setConnectionId(event.target.value)}
								>
									<option value="">Choose your workspace</option>
									{owned.map(value => (
										<option key={value.id} value={value.id}>
											{value.label} · {value.source.commit.slice(0, 8)}
										</option>
									))}
								</select>
								<button
									className="btn btn-primary"
									disabled={busy || !(connectionId || owned.length === 1)}
									onClick={() =>
										void act(() =>
											store.action(item.id, "run", { connectionId: connectionId || owned[0].id })
										)}
								>
									Run on my workspace
								</button>
							</div>
						)}
						{canEdit && ["queued", "running", "publishing"].includes(item.state)
							&& item.input?.authorizer === userId && (
							<button
								className="btn btn-outline"
								disabled={busy}
								onClick={() => void act(() => store.action(item.id, "cancel", {}))}
							>
								Cancel investigation
							</button>
						)}
						{canEdit && ["failed", "cancelled", "interrupted"].includes(item.state) && (
							<button
								className="btn btn-outline"
								disabled={busy}
								onClick={() =>
									void act(async () => {
										let value = await store.action("", "", {
											id: crypto.randomUUID(),
											brief: item.brief,
											parentId: item.id,
										});
										setSelected(value.id);
									})}
							>
								Propose retry
							</button>
						)}
						{item.result && (
							<>
								<StaticPlanEditor source={item.result.report} />
								{item.result.views.map(view => (
									<ExperimentView
										key={view.key}
										result={item.result!}
										view={view}
										state={item.views[view.key]}
									/>
								))}
								<p className="text-xs text-text-secondary">{item.result.provenance.environment}</p>
								{item.result.provenance.limitations.map((value, index) => (
									<p key={index} className="text-sm">{value}</p>
								))}
								{item.result.evidence.map(value => (
									<details key={value.key}>
										<summary className="text-sm">{value.title}</summary>
										<pre className="max-h-64 overflow-auto text-xs">{value.text}</pre>
									</details>
								))}
							</>
						)}
					</>
				)}
				<button className="btn btn-ghost" onClick={onClose}>Close investigations</button>
			</div>
		</NavigationDialog>
	);
}
