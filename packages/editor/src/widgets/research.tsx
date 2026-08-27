import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";

import { SidecarCard } from "../card";
import { widgets$ } from "../widget-options";

import type { FormEvent, KeyboardEvent } from "react";
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
	blocked?: string;
	busyLabel?: string;
	cancelDisabled?: boolean;
	cancelLabel?: string;
	dismissible?: boolean;
	error?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onEscape?: () => void;
	onSubmit: () => void;
	question: string;
	questionLocked?: boolean;
	submitLabel?: string;
	submitting?: boolean;
};

export function handleResearchComposerKey(
	event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">,
	onEscape: () => void,
	dismissible = true,
) {
	if (event.key !== "Escape") return;
	event.preventDefault();
	event.stopPropagation();
	if (dismissible) onEscape();
}

export function ResearchComposer(
	{
		blocked,
		busyLabel = "Starting…",
		cancelDisabled,
		cancelLabel = "Cancel",
		dismissible = true,
		error,
		onCancel,
		onChange,
		onEscape,
		onSubmit,
		question,
		questionLocked,
		submitLabel = "Start research",
		submitting,
	}: ResearchComposerProps,
) {
	let id = useId();
	let submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<form
			className="plan-research-composer"
			onKeyDown={onEscape
				? event => handleResearchComposerKey(event, onEscape, dismissible)
				: undefined}
			onSubmit={submit}
		>
			<label htmlFor={id}>Research question</label>
			<textarea
				autoFocus
				disabled={submitting}
				id={id}
				maxLength={4096}
				onChange={event => onChange(event.target.value)}
				readOnly={questionLocked}
				rows={3}
				value={question}
			/>
			{blocked && <p role="status">{blocked}</p>}
			{error && <p role="alert">{error}</p>}
			<div className="plan-research-actions">
				<button
					className="btn btn-sm btn-secondary"
					disabled={submitting || cancelDisabled}
					onClick={onCancel}
					type="button"
				>
					{cancelLabel}
				</button>
				<button
					className="btn btn-sm btn-primary"
					disabled={submitting || !!blocked || !question.trim()}
					type="submit"
				>
					{submitting ? busyLabel : submitLabel}
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
	onRemove?: () => void;
	onRetry?: () => void;
};

export function ResearchCard(
	{ actionError, busy, canEdit = true, onCancel, onOpen, onRemove, onRetry, request }:
		ResearchCardProps,
) {
	let ready = request.stage === "ready" && request.child;
	let actions = researchActions(request, canEdit);
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
				{actions.cancel && onCancel && (
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
				{actions.retry && onRetry && (
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
				{actions.open && ready && onOpen && (
					<button className="btn btn-sm btn-primary" disabled={busy} onClick={onOpen} type="button">
						Open {ready.title}
					</button>
				)}
				{actions.remove && onRemove && (
					<button
						aria-label="Remove research reference"
						className="btn btn-sm btn-ghost"
						disabled={busy || !canEdit}
						onClick={onRemove}
						type="button"
					>
						Remove
					</button>
				)}
			</div>
		</SidecarCard>
	);
}

export type ResearchActions = {
	cancel: boolean;
	open: boolean;
	remove: boolean;
	retry: boolean;
};

const NONE: ResearchActions = { cancel: false, open: false, remove: false, retry: false };

export function researchActions(
	request: Research.RequestView | undefined,
	canEdit: boolean,
): ResearchActions {
	if (!request) return NONE;
	if (request.stage === "ready") return { ...NONE, open: true, remove: canEdit };
	if (!canEdit) return NONE;
	if (["queued", "searching", "analyzing", "writing"].includes(request.stage)) {
		return { ...NONE, cancel: true };
	}
	if (request.stage === "failed" || request.stage === "cancelled") {
		return { ...NONE, remove: true, retry: true };
	}
	return NONE;
}

export type ResearchReferenceProps = {
	canEdit?: boolean;
	id: string;
	onRemove: () => void;
	store: ResearchStore;
};

export function ResearchReference({ canEdit = true, id, onRemove, store }: ResearchReferenceProps) {
	let subscribe = useCallback(
		(listener: () => void) => store.subscribe(listener),
		[store],
	);
	let request = useSyncExternalStore(
		subscribe,
		() => store.get(id),
		() => store.get(id),
	);
	let [busy, setBusy] = useState(false);
	let [actionError, setActionError] = useState<string>();

	useEffect(() => store.retain(id), [id, store]);

	if (!request) {
		return (
			<SidecarCard label="Research">
				<strong>Loading research…</strong>
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
	let actions = researchActions(request, canEdit);

	return (
		<ResearchCard
			actionError={actionError}
			busy={busy}
			canEdit={canEdit}
			request={request}
			onCancel={actions.cancel ? () => action(() => store.cancel(request.id)) : undefined}
			onOpen={actions.open && request.child ? () => store.open(request.child!) : undefined}
			onRemove={actions.remove ? onRemove : undefined}
			onRetry={actions.retry ? () => action(() => store.retry(request.id)) : undefined}
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
			</SidecarCard>
		);
}

export function renderResearch(node: ResearchNode) {
	return <InlineResearch id={node.getId()} node={node} />;
}
