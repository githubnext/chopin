import { useEffect, useState, useSyncExternalStore } from "react";
import { InvestigationCard, SidecarCard } from "@chopin/editor";
import { ExperimentView } from "@chopin/experiment/react";
import { StaticPlanEditor } from "@chopin/editor/static";
import type { ExperimentStore } from "./store";
import { EvidenceActions, ItemDecisions } from "./evidence";
import type { InvestigationState, PublishedInvestigation } from "@chopin/experiment/records";

const ACTIVE: InvestigationState[] = ["queued", "running", "publishing"];
const SETTLED: InvestigationState[] = ["failed", "cancelled", "interrupted"];

/** The freshest state this browser knows, from the list or a loaded record. */
function latest(store: ExperimentStore, id: string) {
	let summary = store.items.find(item => item.id === id);
	let value = store.get(id);
	if (!summary) return value;
	return value && value.revision > summary.revision ? value : summary;
}

/**
 * Whether a document may drop this investigation's card. Only stopped or failed work can go:
 * a ready card is withdrawn first, and a completed one stays as the result's place in the
 * document. The server applies the same rule.
 */
export function removableInvestigation(store: ExperimentStore, id: string): boolean {
	let state = latest(store, id)?.state;
	return !!state && SETTLED.includes(state);
}

/** The inline card for one investigation, placed in the document by its id. */
export function InvestigationReference({ store, id, userId, canEdit, locked, onRemove }: {
	store: ExperimentStore;
	id: string;
	userId: string;
	canEdit: boolean;
	locked: boolean;
	onRemove: () => void;
}) {
	useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	let [needsAgent, setNeedsAgent] = useState(false);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let summary = store.items.find(item => item.id === id);
	let item = store.get(id);
	let current = latest(store, id);
	let revision = summary?.revision;
	useEffect(() => {
		if (!store.get(id) || revision !== undefined && store.get(id)!.revision < revision) {
			void store.load(id);
		}
	}, [store, id, revision]);
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
	let state = current?.state;
	let brief = current?.brief;
	if (!state || !brief) {
		return (
			<SidecarCard label="Investigation">
				<p role="status" className="m-0 text-sm text-text-tertiary">
					{store.error ? "Investigation unavailable" : "Loading investigation…"}
				</p>
			</SidecarCard>
		);
	}
	let stoppable = ACTIVE.includes(state) && item?.input?.authorizer === userId;
	return (
		<InvestigationCard
			brief={brief}
			busy={busy}
			canEdit={canEdit && (stoppable || !locked)}
			error={error}
			notice={needsAgent && <AgentHint />}
			onRemove={canEdit && state === "requested"
				? () =>
					void act(async () => {
						// Withdraw the record before its card leaves, so nothing is left unplaced.
						await store.action(id, "cancel", {});
						onRemove();
					})
				: canEdit && SETTLED.includes(state)
				? onRemove
				: undefined}
			onRetry={canEdit && SETTLED.includes(state)
				? () => void act(() => store.action(id, "retry", {}))
				: undefined}
			onRun={canEdit && state === "requested"
				? () => void act(() => store.action(id, "run", {}))
				: undefined}
			onStop={canEdit && stoppable
				? () => void act(() => store.action(id, "cancel", {}))
				: undefined}
			progress={current?.progress}
			state={state}
		>
			{item?.result && (
				<Result item={item} store={store} busy={busy} canEdit={canEdit} locked={locked} act={act} />
			)}
		</InvestigationCard>
	);
}

function AgentHint() {
	return (
		<div className="grid gap-2 rounded-md bg-inset p-3 text-sm text-text-secondary">
			<p className="m-0">Start your local agent to run this:</p>
			<code className="block overflow-x-auto rounded-sm border border-edge bg-page p-2 font-mono text-xs text-text-primary">
				{`CHOPIN_URL=${location.origin} bun run connector connect /path/to/project -- copilot --acp`}
			</code>
			<p className="m-0">Open the link it prints, then press Run again.</p>
		</div>
	);
}

function Result({ item, store, busy, canEdit, locked, act }: {
	item: PublishedInvestigation;
	store: ExperimentStore;
	busy: boolean;
	canEdit: boolean;
	locked: boolean;
	act: (action: () => Promise<unknown>) => Promise<void>;
}) {
	let result = item.result!;
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<details>
				<summary className="cursor-pointer text-sm text-text-secondary hover:text-text-primary">
					Report
				</summary>
				<div className="pt-2">
					<StaticPlanEditor source={result.report} />
				</div>
			</details>
			{result.views.map(view => (
				<div key={view.key} className="flex flex-col gap-3">
					<ExperimentView
						result={result}
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
			<p className="m-0 text-xs text-text-secondary">{result.provenance.environment}</p>
			{result.provenance.limitations.map((value, index) => (
				<p key={index} className="m-0 text-sm">{value}</p>
			))}
			<ItemDecisions store={store} item={item} canEdit={canEdit && !locked} />
			{result.evidence.map(value => (
				<details key={value.key}>
					<summary className="text-sm">{value.title}</summary>
					<pre className="max-h-64 overflow-auto text-xs">{value.text}</pre>
				</details>
			))}
		</div>
	);
}
