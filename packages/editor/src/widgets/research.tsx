import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";

import { SidecarCard } from "../card";
import { widgets$ } from "../widget-options";

import type { FormEvent } from "react";
import type { Research } from "@chopin/protocol";
import type { ResearchNode } from "@chopin/dialect";
import type { ResearchStore } from "../widget-options";

const STAGES: Record<Research.RequestStage, string> = {
	queued: "Queued",
	searching: "Searching",
	analyzing: "Analyzing",
	writing: "Writing",
	publishing: "Publishing",
	ready: "Research ready",
	failed: "Research failed",
	cancelled: "Research cancelled",
};

export type ResearchComposerProps = {
	error?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onSubmit: () => void;
	question: string;
	submitting?: boolean;
};

export function ResearchComposer(
	{ error, onCancel, onChange, onSubmit, question, submitting }: ResearchComposerProps,
) {
	let id = useId();
	let submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<form className="plan-research-composer" onSubmit={submit}>
			<label htmlFor={id}>Research question</label>
			<textarea
				autoFocus
				disabled={submitting}
				id={id}
				maxLength={4096}
				onChange={event => onChange(event.target.value)}
				rows={3}
				value={question}
			/>
			{error && <p role="alert">{error}</p>}
			<div className="plan-research-actions">
				<button
					className="btn btn-sm btn-secondary"
					disabled={submitting}
					onClick={onCancel}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-sm btn-primary"
					disabled={submitting || !question.trim()}
					type="submit"
				>
					{submitting ? "Starting…" : "Start research"}
				</button>
			</div>
		</form>
	);
}

export type ResearchCardProps = {
	actionError?: string;
	busy?: boolean;
	canEdit?: boolean;
	request: Research.RequestView;
	onCancel?: () => void;
	onOpen?: () => void;
	onRemove: () => void;
	onRetry?: () => void;
};

export function ResearchCard(
	{ actionError, busy, canEdit = true, onCancel, onOpen, onRemove, onRetry, request }:
		ResearchCardProps,
) {
	let ready = request.stage === "ready" && request.child;
	return (
		<SidecarCard label="Research">
			<div className="plan-research-heading">
				<strong>{STAGES[request.stage]}</strong>
				<span>{request.question}</span>
			</div>
			{request.error && <p className="plan-research-error" role="status">{request.error}</p>}
			{request.sources.length > 0 && (
				<ul aria-label="Research sources" className="plan-research-sources">
					{request.sources.map(source => (
						<li key={source.url}>
							<a href={source.url} rel="noreferrer" target="_blank">{source.title}</a>
						</li>
					))}
				</ul>
			)}
			{actionError && <p className="plan-research-error" role="status">{actionError}</p>}
			<div className="plan-research-actions">
				{onCancel && (
					<button
						aria-label="Cancel research"
						className="btn btn-sm btn-secondary"
						disabled={busy || !canEdit}
						onClick={onCancel}
						type="button"
					>
						Cancel
					</button>
				)}
				{onRetry && (
					<button
						aria-label="Retry research"
						className="btn btn-sm btn-secondary"
						disabled={busy || !canEdit}
						onClick={onRetry}
						type="button"
					>
						Retry
					</button>
				)}
				{ready && onOpen && (
					<button className="btn btn-sm btn-primary" disabled={busy} onClick={onOpen} type="button">
						Open {ready.title}
					</button>
				)}
				<button
					aria-label="Remove research reference"
					className="btn btn-sm btn-ghost"
					disabled={busy || !canEdit}
					onClick={onRemove}
					type="button"
				>
					Remove
				</button>
			</div>
		</SidecarCard>
	);
}

export function retryResearch(
	store: ResearchStore,
	request: Research.RequestView,
): Promise<Research.RequestView> {
	return store.retry(request.id, request.question);
}

export type ResearchReferenceProps = {
	canEdit?: boolean;
	id: string;
	onRemove: () => void;
	store: ResearchStore;
};

export function ResearchReference({ canEdit = true, id, onRemove, store }: ResearchReferenceProps) {
	let request = useSyncExternalStore(
		store.subscribe,
		() => store.get(id),
		() => store.get(id),
	);
	let [busy, setBusy] = useState(false);
	let [actionError, setActionError] = useState<string>();

	useEffect(() => store.refresh(id), [id, store]);

	if (!request) {
		return (
			<SidecarCard label="Research">
				<strong>Loading research…</strong>
				<div className="plan-research-actions">
					<button
						aria-label="Remove research reference"
						className="btn btn-sm btn-ghost"
						disabled={!canEdit}
						onClick={onRemove}
						type="button"
					>
						Remove
					</button>
				</div>
			</SidecarCard>
		);
	}

	let action = (run: () => Promise<Research.RequestView>) => {
		setBusy(true);
		setActionError(undefined);
		void run().catch(() => setActionError("Research could not be updated.")).finally(() =>
			setBusy(false)
		);
	};
	let active = request.stage !== "ready" && request.stage !== "failed"
		&& request.stage !== "cancelled";
	let retryable = request.stage === "failed" || request.stage === "cancelled";

	return (
		<ResearchCard
			actionError={actionError}
			busy={busy}
			canEdit={canEdit}
			request={request}
			onCancel={canEdit && active ? () => action(() => store.cancel(request.id)) : undefined}
			onOpen={request.child ? () => store.open(request.child!) : undefined}
			onRemove={onRemove}
			onRetry={canEdit && retryable ? () => action(() => retryResearch(store, request)) : undefined}
		/>
	);
}

function InlineResearch({ id, node }: { id: string; node: ResearchNode }) {
	let [editor] = useLexicalComposerContext();
	let options = useCellValue(widgets$);
	let store = options.research;
	let remove = () => editor.update(() => node.getLatest().remove());
	return store
		? (
			<ResearchReference
				canEdit={options.canEdit}
				id={id}
				onRemove={remove}
				store={store}
			/>
		)
		: (
			<SidecarCard label="Research">
				<strong>Research unavailable</strong>
				<div className="plan-research-actions">
					<button
						aria-label="Remove research reference"
						className="btn btn-sm btn-ghost"
						disabled={!options.canEdit}
						onClick={remove}
						type="button"
					>
						Remove
					</button>
				</div>
			</SidecarCard>
		);
}

export function renderResearch(node: ResearchNode) {
	return <InlineResearch id={node.getId()} node={node} />;
}
