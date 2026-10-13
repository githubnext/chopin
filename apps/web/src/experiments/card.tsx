import { useEffect, useState, useSyncExternalStore } from "react";
import { InvestigationCard, SidecarCard } from "@chopin/editor";
import type { ExperimentStore } from "./store";
import { ItemDecisions } from "./evidence";
import { LocalAgentNote } from "../local-agent-note";
import type { InvestigationChild, InvestigationState } from "@chopin/experiment/records";

const ACTIVE: ReadonlySet<InvestigationState> = new Set(["queued", "running", "publishing"]);
const SETTLED: ReadonlySet<InvestigationState> = new Set(["failed", "cancelled", "interrupted"]);

/** Plain copy for a refused card action; unknown refusals keep the server's words. */
const REFUSALS: Record<string, string> = {
	"document-archived": "This document is archived.",
	"document-locked": "This document is locked while it builds.",
	"repository-forbidden": "You need push access to this repository.",
	"invalid-state": "This investigation has already started or ended.",
	"connection-forbidden": "That local agent isn’t yours to use.",
	"connection-unavailable": "That local agent disconnected. Start it again, then retry.",
	"workspace-busy": "Your local agent is busy. Try again when it finishes.",
	"child-document": "Investigations start only in a top-level document.",
};

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
	return !!state && SETTLED.has(state) && !latest(store, id)?.buildBlocker;
}

/** The inline card for one investigation, placed in the document by its id. */
export function InvestigationReference(
	{ store, id, userId, canEdit, locked, onRemove, onOpen, onApply }: {
		store: ExperimentStore;
		id: string;
		userId: string;
		canEdit: boolean;
		locked: boolean;
		onRemove: () => void;
		onApply?: () => Promise<unknown>;
		/** Open the child document a completed investigation was published as. */
		onOpen?: (child: InvestigationChild, opener: HTMLElement) => void;
	},
) {
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
			else setError(REFUSALS[message] ?? message);
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
	let stoppable = ACTIVE.has(state) && item?.input?.authorizer === userId;
	let child = state === "completed" ? item?.child : undefined;
	// A completed record loaded without a child has lost its document; say so plainly.
	let orphaned = state === "completed" && !!item && item.revision >= (revision ?? 0) && !child;
	return (
		<InvestigationCard
			brief={brief}
			busy={busy}
			canEdit={canEdit && (stoppable || !locked)}
			error={error}
			id={id}
			notice={
				<>
					{current?.buildBlocker && (
						<p className="m-0 text-sm text-text-secondary">
							<strong>Required before building:</strong> {current.buildBlocker}
							{state === "completed" && " · Apply the findings before building."}
						</p>
					)}
					{state === "completed" && current?.buildBlocker && onApply && canEdit && (
						<div>
							<button
								className="btn btn-compact btn-outline"
								disabled={busy || locked}
								onClick={() => void act(onApply)}
								type="button"
							>
								Apply findings
							</button>
						</div>
					)}
					{needsAgent ? <AgentHint /> : orphaned && (
						<p className="m-0 text-sm text-text-secondary">
							Its published document is no longer available.
						</p>
					)}
				</>
			}
			onOpen={child && onOpen ? opener => onOpen(child, opener) : undefined}
			onRemove={canEdit && state === "requested"
				? () =>
					void act(async () => {
						// Withdraw the record before its card leaves, so nothing is left unplaced.
						await store.action(id, "cancel", {});
						onRemove();
					})
				: canEdit && removableInvestigation(store, id)
				? onRemove
				: undefined}
			onRetry={canEdit && SETTLED.has(state)
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
	return <LocalAgentNote action="Run" />;
}
