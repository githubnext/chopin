import { useEffect, useState, useSyncExternalStore } from "react";
import { useCellValue } from "@mdxeditor/gurx";
import { ExperimentView } from "@chopin/experiment/react";
import type { ExperimentNode } from "@chopin/dialect";
import { widgets$ } from "../widget-options";

function emptySubscribe() {
	return () => {};
}
function emptySnapshot() {
	return 0;
}

function Reference(
	{ experiment, view: viewKey, decision: decisionId }: {
		experiment: string;
		view: string;
		decision: string;
	},
) {
	let { experiments: store, canEdit, connected } = useCellValue(widgets$);
	useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.snapshot ?? emptySnapshot);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	useEffect(() => {
		if (store && !store.get(experiment)) void store.load(experiment);
	}, [store, experiment]);
	let value = store?.get(experiment);
	let view = value?.result?.views.find(view => view.key === viewKey);
	let decision = decisionId ? value?.decisions.find(item => item.id === decisionId) : undefined;
	if (!store || !value?.result || !view || decisionId && !decision) {
		return <p className="text-sm text-text-secondary">Investigation evidence unavailable.</p>;
	}
	let state = decision?.state ?? value.views[viewKey];
	async function act(action: () => Promise<void>) {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
			await store!.load(experiment);
		}
	}
	return (
		<article
			aria-label={decision ? "Saved investigation evidence" : "Investigation evidence"}
			className="my-4 flex flex-col gap-3 rounded-md border p-4"
			contentEditable={false}
		>
			{decision && (
				<>
					<h3 className="text-base font-semibold">{decision.conclusion}</h3>
					<p className="text-sm">{decision.rationale}</p>
					<p className="text-xs text-text-secondary">Recorded by {decision.by} · Fixed evidence</p>
				</>
			)}
			{error && <p role="alert" className="text-sm text-destructive-ink">{error}</p>}
			<ExperimentView
				result={value.result}
				view={view}
				state={state}
				disabled={busy || !canEdit || !connected || !!decision}
				onChange={(field, values) =>
					void act(() =>
						store.change(experiment, viewKey, {
							mutationId: crypto.randomUUID(),
							expected: { [field]: state.fields[field].revision },
							set: { [field]: values },
						})
					)}
			/>
			{canEdit && connected && (
				<button
					className="btn btn-sm btn-ghost"
					disabled={busy}
					onClick={() =>
						void act(() => store.place(experiment, viewKey, decisionId || undefined, true))}
				>
					Remove evidence from document
				</button>
			)}
		</article>
	);
}

export function renderExperiment(node: ExperimentNode) {
	return (
		<Reference
			experiment={node.getExperiment()}
			view={node.getView()}
			decision={node.getDecision()}
		/>
	);
}
