import { useEffect, useState } from "react";
import { ExperimentView } from "@chopin/experiment/react";
import { StaticPlanEditor } from "@chopin/editor/static";
import type { ExperimentStore } from "./store";
import { EvidenceActions } from "./evidence";
import type { InvestigationSummary } from "@chopin/experiment/records";

export function InvestigationCard({ store, summary, userId, canEdit, locked }: {
	store: ExperimentStore;
	summary: InvestigationSummary;
	userId: string;
	canEdit: boolean;
	locked: boolean;
}) {
	let [connectionId, setConnectionId] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let [loadFailed, setLoadFailed] = useState(false);
	let [loading, setLoading] = useState(!store.get(summary.id));
	let item = store.get(summary.id);
	let owned = store.connections.filter(connection => connection.owner === userId);
	let load = async () => {
		setLoading(true);
		await store.load(summary.id);
		if (loadFailed && store.get(summary.id)) void store.refresh();
		setLoadFailed(!store.get(summary.id));
		setLoading(false);
	};
	useEffect(() => {
		if (!store.get(summary.id)) void load();
	}, [store, summary.id]);
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
		<article
			aria-label={summary.brief}
			className="flex min-w-0 flex-col gap-3 rounded-md border border-edge p-4"
		>
			<h3 className="m-0 break-words text-sm font-semibold">{summary.brief}</h3>
			<p role="status" className="m-0 text-xs text-text-secondary">
				{summary.state} {summary.progress && `· ${summary.progress}`}
			</p>
			{error && <p role="alert" className="m-0 text-sm text-destructive-ink">{error}</p>}
			{!item && loading && <p role="status" className="m-0 text-sm">Loading investigation…</p>}
			{loadFailed && !item && (
				<button
					className="btn btn-sm btn-outline"
					disabled={loading}
					onClick={() => void load()}
				>
					Retry loading
				</button>
			)}
			{item && (
				<>
					{canEdit && item.state === "requested" && (
						<div className="flex flex-wrap gap-2">
							{owned.length === 0 && (
								<p className="w-full m-0 text-sm text-text-secondary">
									Connect a local workspace to run this investigation.
								</p>
							)}
							<select
								aria-label="Your workspace"
								className="field text-sm"
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
								className="btn btn-md btn-primary"
								disabled={busy || locked || !(connectionId || owned.length === 1)}
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
							className="btn btn-md btn-outline"
							disabled={busy}
							onClick={() => void act(() => store.action(item.id, "cancel", {}))}
						>
							Cancel investigation
						</button>
					)}
					{canEdit && ["failed", "cancelled", "interrupted"].includes(item.state) && (
						<button
							className="btn btn-md btn-outline"
							disabled={busy || locked}
							onClick={() =>
								void act(async () => {
									await store.action("", "", {
										id: crypto.randomUUID(),
										brief: item.brief,
										parentId: item.id,
									});
								})}
						>
							Propose retry
						</button>
					)}
					{item.result && (
						<>
							<details>
								<summary className="text-sm">Report</summary>
								<StaticPlanEditor source={item.result.report} />
							</details>
							{item.result.views.map(view => (
								<div key={view.key} className="flex flex-col gap-3">
									<ExperimentView
										key={view.key}
										result={item.result!}
										view={view}
										state={item.views[view.key]}
										disabled={busy || !canEdit}
										onChange={(field, values) =>
											void act(async () => {
												try {
													await store.action(item.id, "state", {
														view: view.key,
														patch: {
															mutationId: crypto.randomUUID(),
															expected: { [field]: item.views[view.key].fields[field].revision },
															set: { [field]: values },
														},
													});
												} finally {
													await store.load(item.id);
												}
											})}
									/>
									<EvidenceActions
										store={store}
										item={item}
										view={view}
										disabled={busy || !canEdit || locked}
									/>
									<div className="flex gap-3 text-sm">
										<a
											href={`/api/documents/${store.documentId}/experiments/${item.id}/export/${view.datasetKey}`}
										>
											Download JSON
										</a>
										<a
											href={`/api/documents/${store.documentId}/experiments/${item.id}/export/${view.datasetKey}?format=csv`}
										>
											Download CSV
										</a>
									</div>
								</div>
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
		</article>
	);
}
