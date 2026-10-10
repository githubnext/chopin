import { useEffect, useState } from "react";
import { ExperimentView } from "@chopin/experiment/react";
import { StaticPlanEditor } from "@chopin/editor/static";
import type { ExperimentStore } from "./store";
import { EvidenceActions } from "./evidence";
import type { InvestigationState, InvestigationSummary } from "@chopin/experiment/records";

const WORDS: Record<InvestigationState, string> = {
	requested: "Ready to run",
	queued: "Waiting for your local agent",
	running: "Running",
	publishing: "Writing up",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
	interrupted: "Interrupted",
};

export function InvestigationCard({ store, summary, userId, canEdit, locked }: {
	store: ExperimentStore;
	summary: InvestigationSummary;
	userId: string;
	canEdit: boolean;
	locked: boolean;
}) {
	let [needsAgent, setNeedsAgent] = useState(false);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let [loadFailed, setLoadFailed] = useState(false);
	let [loading, setLoading] = useState(!store.get(summary.id));
	let item = store.get(summary.id);
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
		setNeedsAgent(false);
		try {
			await action();
		} catch (error) {
			let message = String((error as Error).message);
			if (message === "no-workspace") setNeedsAgent(true);
			else setError(message);
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
				{WORDS[summary.state] ?? summary.state}
				{summary.state === "running" && summary.progress && ` · ${summary.progress}`}
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
						<div className="flex flex-col items-start gap-3">
							<button
								className="btn btn-md btn-primary"
								disabled={busy || locked}
								onClick={() => void act(() => store.action(item.id, "run", {}))}
							>
								Run
							</button>
							{needsAgent && (
								<div className="grid w-full gap-2 rounded-md bg-inset p-3 text-sm text-text-secondary">
									<p className="m-0">Start your local agent to run this:</p>
									<code className="block overflow-x-auto rounded-sm border border-edge bg-page p-2 font-mono text-xs text-text-primary">
										{`CHOPIN_URL=${location.origin} bun run connector connect /path/to/project -- copilot --acp`}
									</code>
									<p className="m-0">Open the link it prints, then press Run again.</p>
								</div>
							)}
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
