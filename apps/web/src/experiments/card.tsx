import { useEffect, useState, useSyncExternalStore } from "react";
import { InvestigationCard, SidecarCard } from "@chopin/editor";
import type { ExperimentStore } from "./store";
import { ItemDecisions } from "./evidence";
import type { InvestigationChild, InvestigationState } from "@chopin/experiment/records";

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
 * a ready card is withdrawn first, and a completed one stays as the link to its child
 * document. The server applies the same rule.
 */
export function removableInvestigation(store: ExperimentStore, id: string): boolean {
	let state = latest(store, id)?.state;
	return !!state && SETTLED.includes(state);
}

/** The inline card for one investigation, placed in the document by its id. */
export function InvestigationReference({ store, id, userId, canEdit, locked, onRemove, onOpen }: {
	store: ExperimentStore;
	id: string;
	userId: string;
	canEdit: boolean;
	locked: boolean;
	onRemove: () => void;
	/** Open the child document a completed investigation was published as. */
	onOpen?: (child: InvestigationChild, opener: HTMLElement) => void;
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
	let child = state === "completed" ? item?.child : undefined;
	return (
		<InvestigationCard
			brief={brief}
			busy={busy}
			canEdit={canEdit && (stoppable || !locked)}
			error={error}
			id={id}
			notice={needsAgent && <AgentHint />}
			onOpen={child && onOpen ? opener => onOpen(child, opener) : undefined}
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
			ready={child && {
				title: child.title,
				summary: child.summary,
				views: item?.result?.views.length ?? 0,
			}}
			state={state}
		>
			{child && item && <ItemDecisions store={store} item={item} canEdit={canEdit && !locked} />}
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
