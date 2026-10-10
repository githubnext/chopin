import { useState, useSyncExternalStore } from "react";
import { InvestigationCard } from "./card";
import { EvidenceDecisions } from "./evidence";
import { RequestIdentity } from "./request-id";
import type { ExperimentStore } from "./store";

export function InlineInvestigations({ store, userId, canEdit, locked }: {
	store: ExperimentStore;
	userId: string;
	canEdit: boolean;
	locked: boolean;
}) {
	useSyncExternalStore(store.subscribe, store.snapshot);
	let [brief, setBrief] = useState("");
	let [open, setOpen] = useState(false);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	let [creation] = useState(() => new RequestIdentity());
	if (!canEdit && !store.items.length && !store.error) return null;
	return (
		<section aria-label="Local investigations" className="flex min-w-0 flex-col gap-4">
			{(error || store.error) && (
				<p role="alert" className="m-0 text-sm text-destructive-ink">{error || store.error}</p>
			)}
			{store.items.map(summary => (
				<InvestigationCard
					key={summary.id}
					store={store}
					summary={summary}
					userId={userId}
					canEdit={canEdit}
					locked={locked}
				/>
			))}
			<EvidenceDecisions store={store} canEdit={canEdit && !locked} />
			{canEdit && !locked && (
				<details
					open={open}
					onToggle={event => setOpen(event.currentTarget.open)}
				>
					<summary className="cursor-pointer text-sm text-text-tertiary">
						Propose investigation
					</summary>
					<form
						className="mt-3 flex flex-col gap-2"
						onSubmit={event => {
							event.preventDefault();
							if (busy) return;
							setBusy(true);
							setError("");
							void store.action("", "", { id: creation.key({ brief }), brief }).then(() => {
								creation.clear();
								setBrief("");
								setOpen(false);
							}).catch(reason => setError(reason.message)).finally(() => setBusy(false));
						}}
					>
						<label className="text-sm">
							Investigation brief
							<textarea
								className="field mt-1 w-full"
								value={brief}
								maxLength={8000}
								onChange={event => setBrief(event.target.value)}
							/>
						</label>
						<button className="btn btn-md btn-primary" disabled={busy || !brief.trim()}>
							Propose investigation
						</button>
					</form>
				</details>
			)}
		</section>
	);
}
