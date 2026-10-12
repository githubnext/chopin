import { useState, useSyncExternalStore } from "react";
import { ExperimentView } from "@chopin/experiment/react";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import type { View } from "@chopin/experiment";
import type { ExperimentStore } from "./store";
import { UnfoldSection } from "@chopin/visuals/unfold";
import { RequestIdentity } from "./request-id";

export function EvidenceActions({ store, item, view, disabled }: {
	store: ExperimentStore;
	item: PublishedInvestigation;
	view: View;
	disabled: boolean;
}) {
	let [open, setOpen] = useState(false);
	let [revision, setRevision] = useState(0);
	let [conclusion, setConclusion] = useState("");
	let [rationale, setRationale] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let [operation] = useState(() => new RequestIdentity());
	async function act(action: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (error) {
			setError((error as Error).message);
			await store.load(item.id);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="flex flex-col gap-2 text-sm">
			{error && <p role="alert" className="text-destructive-ink">{error}</p>}
			<div className="flex flex-wrap gap-2">
				<button
					className="btn btn-md btn-outline"
					disabled={disabled || busy}
					onClick={() => void act(() => store.place(item.id, view.key))}
				>
					Insert view in document
				</button>
				<button
					className="btn btn-md btn-primary"
					disabled={disabled || busy}
					onClick={() => {
						setRevision(item.views[view.key].revision);
						setOpen(true);
					}}
				>
					Record decision
				</button>
			</div>
			{open && (
				<form
					className="flex flex-col gap-2"
					onSubmit={event => {
						event.preventDefault();
						void act(async () => {
							try {
								await store.action(item.id, "decision", {
									id: operation.key({ view: view.key, revision, conclusion, rationale }),
									view: view.key,
									revision,
									conclusion,
									rationale,
								});
								operation.clear();
							} finally {
								setOpen(false);
							}
						});
					}}
				>
					<label>
						Conclusion<input
							aria-label="Decision conclusion"
							className="w-full rounded-md border p-2"
							value={conclusion}
							onChange={event => setConclusion(event.target.value)}
							maxLength={4000}
							required
						/>
					</label>
					<label>
						Rationale<textarea
							aria-label="Decision rationale"
							className="w-full rounded-md border p-2"
							value={rationale}
							onChange={event => setRationale(event.target.value)}
							maxLength={8000}
						/>
					</label>
					<p className="text-xs text-text-secondary">
						Saves the exact evidence and selections shown when you opened this form.
					</p>
					<button
						className="btn btn-md btn-primary"
						disabled={disabled || busy || !conclusion.trim()}
					>
						Save decision
					</button>
				</form>
			)}
		</div>
	);
}

/** One recorded decision with its fixed evidence and the action that embeds it. */
function DecisionRecord({ store, item, decision, canEdit, onError }: {
	store: ExperimentStore;
	item: PublishedInvestigation;
	decision: PublishedInvestigation["decisions"][number];
	canEdit: boolean;
	onError: (message: string) => void;
}) {
	let view = item.result?.views.find(view => view.key === decision.view);
	return (
		<article className="flex flex-col gap-2 rounded-md border p-3 text-sm">
			<h4 className="font-semibold">{decision.conclusion}</h4>
			<p>{decision.rationale}</p>
			<p className="text-xs text-text-secondary">
				Recorded by {decision.by} · Fixed evidence
			</p>
			{view && item.result && (
				<UnfoldSection label="View saved evidence">
					<ExperimentView result={item.result} view={view} state={decision.state} disabled />
				</UnfoldSection>
			)}
			{canEdit && (
				<button
					className="btn btn-md btn-outline"
					onClick={() => {
						onError("");
						void store.place(item.id, decision.view, decision.id).catch(error =>
							onError(error.message)
						);
					}}
				>
					Insert decision evidence in document
				</button>
			)}
		</article>
	);
}

/** The decisions recorded against one investigation, shown on its inline card. */
export function ItemDecisions(
	{ store, item, canEdit }: {
		store: ExperimentStore;
		item: PublishedInvestigation;
		canEdit: boolean;
	},
) {
	let [error, setError] = useState("");
	if (!item.decisions.length) return null;
	return (
		<section aria-label="Investigation decisions" className="flex flex-col gap-3">
			{error && <p role="alert" className="m-0 text-sm text-destructive-ink">{error}</p>}
			{item.decisions.toSorted((a, b) => b.at - a.at).map(decision => (
				<DecisionRecord
					key={decision.id}
					store={store}
					item={item}
					decision={decision}
					canEdit={canEdit}
					onError={setError}
				/>
			))}
		</section>
	);
}

export function EvidenceDecisions(
	{ store, canEdit }: { store: ExperimentStore; canEdit: boolean },
) {
	useSyncExternalStore(store.subscribe, store.snapshot);
	let [error, setError] = useState("");
	let decisions = [...store.values.values()].flatMap(item =>
		item.decisions.map(decision => ({ item, decision }))
	)
		.sort((a, b) => b.decision.at - a.decision.at);
	if (!decisions.length) return null;
	return (
		<section aria-label="Investigation decisions" className="flex flex-col gap-4 p-4">
			<h3 className="text-base font-semibold">Investigation decisions</h3>
			{error && <p role="alert" className="text-sm text-destructive-ink">{error}</p>}
			{decisions.map(({ item, decision }) => (
				<DecisionRecord
					key={decision.id}
					store={store}
					item={item}
					decision={decision}
					canEdit={canEdit}
					onError={setError}
				/>
			))}
		</section>
	);
}
