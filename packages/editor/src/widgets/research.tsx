import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getSelection,
	$isElementNode,
	$isNodeSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_HIGH,
	DELETE_CHARACTER_COMMAND,
	DELETE_LINE_COMMAND,
	DELETE_WORD_COMMAND,
	mergeRegister,
	REMOVE_TEXT_COMMAND,
} from "lexical";

import { SidecarCard } from "../card";
import { SendAction } from "../send-action";
import { Fold, Swap, useLast } from "./research-motion";
import { widgets$ } from "../widget-options";
import { $isResearchNode } from "@chopin/dialect";
import { CloseIcon, SparkleIcon, WarningIcon } from "@chopin/icons";

import type { FormEvent, MouseEvent, ReactNode } from "react";
import type { Research } from "@chopin/protocol";
import type { ResearchNode } from "@chopin/dialect";
import type { LexicalEditor, LexicalNode, RangeSelection } from "lexical";
import type { ResearchStore } from "../widget-options";

const WORDS: Record<Research.RequestStage, string> = {
	queued: "Waiting to start",
	searching: "Searching sources",
	analyzing: "Reading sources",
	writing: "Writing report",
	publishing: "Publishing",
	ready: "Research",
	failed: "Research failed",
	cancelled: "Cancelled",
};

const TRACK: Research.RequestStage[] = [
	"queued",
	"searching",
	"analyzing",
	"writing",
	"publishing",
];

const REMOVABLE_STAGES = new Set<Research.RequestStage>(["failed", "cancelled", "ready"]);

export type ResearchComposerProps = {
	blocked?: string;
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

export function researchComposerKey(event: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	isComposing: boolean;
}): "dismiss" | "ignore" | "newline" | "submit" {
	if (event.isComposing) return "ignore";
	if (event.key === "Escape") return "dismiss";
	if (event.key !== "Enter") return "ignore";
	return event.metaKey || event.ctrlKey ? "newline" : "submit";
}

type ResearchComposerKeyEvent = {
	ctrlKey: boolean;
	currentTarget: {
		readOnly: boolean;
		selectionEnd: number;
		selectionStart: number;
		setRangeText(replacement: string, start: number, end: number, selectionMode: "end"): void;
		value: string;
	};
	key: string;
	keyCode: number;
	metaKey: boolean;
	nativeEvent: { isComposing: boolean };
	preventDefault(): void;
	stopPropagation(): void;
};

export function handleResearchComposerKey(
	event: ResearchComposerKeyEvent,
	actions: {
		dismissible: boolean;
		onChange: (value: string) => void;
		onDismiss: () => void;
		onSubmit: () => void;
	},
) {
	let action = researchComposerKey({
		key: event.key,
		metaKey: event.metaKey,
		ctrlKey: event.ctrlKey,
		isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
	});
	if (action === "ignore") return;
	event.preventDefault();
	event.stopPropagation();
	if (action === "dismiss") {
		if (actions.dismissible) actions.onDismiss();
		return;
	}
	if (action === "submit") {
		actions.onSubmit();
		return;
	}
	let textarea = event.currentTarget;
	if (textarea.readOnly) return;
	textarea.setRangeText(
		"\n",
		textarea.selectionStart,
		textarea.selectionEnd,
		"end",
	);
	actions.onChange(textarea.value);
}

export function ResearchComposer(
	{
		blocked,
		cancelDisabled,
		cancelLabel,
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
	let submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<form className="plan-research-composer" onSubmit={submit}>
			<div className="plan-research-field">
				<textarea
					aria-label="Research question"
					autoFocus
					className="field"
					disabled={submitting}
					maxLength={4096}
					onChange={event => onChange(event.target.value)}
					onKeyDown={event =>
						handleResearchComposerKey(event, {
							dismissible,
							onChange,
							onDismiss: onEscape ?? onCancel,
							onSubmit,
						})}
					placeholder="What should Chopin research?"
					readOnly={questionLocked}
					rows={3}
					value={question}
				/>
				{dismissible && !submitting && (
					<button
						aria-label="Discard research question"
						className="plan-research-dismiss btn btn-icon btn-ghost"
						data-tooltip="Discard research"
						onClick={onCancel}
						type="button"
					>
						<CloseIcon aria-hidden="true" size={14} />
					</button>
				)}
				<div className="plan-research-send">
					<SendAction
						busy={submitting}
						disabled={submitting || !!blocked || !question.trim()}
						label={submitLabel}
						onClick={onSubmit}
					/>
				</div>
			</div>
			{blocked && <p role="status">{blocked}</p>}
			{error && <p role="alert">{error}</p>}
			{cancelLabel && (
				<div className="plan-research-actions">
					<button
						className="btn btn-sm btn-secondary"
						disabled={submitting || cancelDisabled}
						onClick={onCancel}
						type="button"
					>
						{cancelLabel}
					</button>
				</div>
			)}
		</form>
	);
}

export type ResearchCardProps = {
	actionError?: string;
	busy?: boolean;
	canEdit?: boolean;
	openButtonRef?: (button: HTMLButtonElement | null) => void;
	request: Research.RequestView;
	onCancel?: () => void;
	onOpen?: (opener: HTMLElement) => void;
	onRemove?: () => void;
	onRetry?: () => void;
};

function Indicator({ stage }: { stage: Research.RequestStage }) {
	if (stage === "failed") {
		return (
			<span aria-hidden="true" className="plan-research-badge">
				<WarningIcon size={14} />
			</span>
		);
	}
	if (stage === "ready") {
		return (
			<span aria-hidden="true" className="plan-research-badge" data-tone="brand">
				<SparkleIcon size={14} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="plan-research-dot"
			data-idle={stage === "cancelled" ? "" : undefined}
		/>
	);
}

/** A question is context, not a heading: two quiet lines that open on request. */
export function ResearchBrief({ text }: { text: string }) {
	let [open, setOpen] = useState(false);
	let [long, setLong] = useState(false);
	let ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		let element = ref.current;
		if (!element || open) return;
		let measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [text, open]);
	return (
		<>
			<span className="plan-research-brief" data-open={open ? "" : undefined} ref={ref}>
				{text}
			</span>
			{(long || open) && (
				<button
					aria-expanded={open}
					className="plan-research-more"
					onClick={() => setOpen(!open)}
					type="button"
				>
					{open ? "Show less" : "Show more"}
				</button>
			)}
		</>
	);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function ResearchCard(
	{
		actionError,
		busy,
		canEdit = true,
		onCancel,
		onOpen,
		onRemove,
		onRetry,
		openButtonRef,
		request,
	}: ResearchCardProps,
) {
	let stage = request.stage;
	let ready = stage === "ready" && request.child ? request.child : undefined;
	let sourceCount = ready
		? ready.sourceCount === 0 ? "No sources" : plural(ready.sourceCount, "source")
		: undefined;
	let actions = researchActions(request, canEdit);
	let footer: "cancel" | "retry" | undefined = actions.retry && onRetry
		? "retry"
		: actions.cancel && onCancel
		? "cancel"
		: undefined;
	let removable = !ready && actions.remove && !!onRemove;
	let at = TRACK.indexOf(stage);
	let shownAt = useLast(at >= 0 ? at : undefined);
	let found = request.sources.length;
	// The user's latest action result leads; the request's own failure follows.
	let messages = [actionError, request.error].filter((text): text is string => !!text);
	let message = messages.length > 0 ? messages : undefined;
	let shownMessages = useLast(message);
	let settle = (event: MouseEvent<HTMLElement>, run?: () => void) => {
		let card = event.currentTarget.closest("article");
		run?.();
		card?.focus({ preventScroll: true });
	};
	let shownSummary = useLast(ready?.summary);
	let shownFound = useLast(found > 0 ? found : undefined);
	let attention: ReactNode = shownMessages !== undefined && (
		<div aria-hidden="true" className="plan-research-callout">
			{shownMessages.map(text => <p key={text}>{text}</p>)}
		</div>
	);
	return (
		<div className="plan-research-tracked">
			<SidecarCard
				className={`plan-research-card${ready ? " relative" : ""}`}
				data-research-ready={ready ? "" : undefined}
				data-stage={stage}
				label="Research"
				tabIndex={-1}
			>
				<span className="sr-only" role="status">{message?.join(" ")}</span>
				<div
					className="plan-research-status"
					data-lead={stage === "failed" || stage === "ready" ? "" : undefined}
				>
					<Swap
						className="plan-research-indicator"
						id={stage === "ready" || stage === "failed" ? stage : "dot"}
					>
						<Indicator stage={stage} />
					</Swap>
					<Swap id={stage}>
						<span>
							{WORDS[stage]}
							{sourceCount && <span className="plan-research-meta">{"\u00a0· "}{sourceCount}</span>}
						</span>
					</Swap>
					<div className="plan-research-remove">
						<Swap id={removable ? "remove" : "none"}>
							{removable && (
								<button
									aria-label="Remove research reference"
									className="btn btn-icon btn-ghost"
									data-tooltip="Remove"
									disabled={busy || !canEdit}
									onClick={event => settle(event, onRemove)}
									type="button"
								>
									<CloseIcon aria-hidden="true" size={14} />
								</button>
							)}
						</Swap>
					</div>
				</div>
				<Swap className="plan-research-title" id={ready ? "report" : "question"}>
					{ready ? ready.title : <ResearchBrief text={request.question} />}
				</Swap>
				<Fold open={!!ready}>
					{shownSummary !== undefined && <p className="plan-research-summary">{shownSummary}</p>}
				</Fold>
				<Fold open={message !== undefined}>{attention}</Fold>
				<Fold open={!!footer}>
					<div className="plan-research-footer">
						<Swap id={footer ?? "none"}>
							{footer && (
								<button
									aria-label={footer === "retry" ? "Retry research" : "Cancel research"}
									className="btn btn-sm btn-outline"
									disabled={busy || !canEdit}
									onClick={event => settle(event, footer === "retry" ? onRetry : onCancel)}
									type="button"
								>
									{footer === "retry" ? "Retry" : "Cancel"}
								</button>
							)}
						</Swap>
					</div>
				</Fold>
				{actions.open && ready && onOpen && (
					<button
						aria-label={`Open ${ready.title}`}
						className="plan-research-open"
						disabled={busy}
						onClick={event => onOpen(event.currentTarget)}
						ref={openButtonRef}
						type="button"
					/>
				)}
			</SidecarCard>
			<Fold open={at >= 0}>
				<div aria-hidden="true" className="plan-research-track">
					{TRACK.map((step, index) => (
						<span
							data-state={shownAt === undefined || index > shownAt
								? "todo"
								: index === shownAt
								? "now"
								: "done"}
							key={step}
						/>
					))}
				</div>
				<Fold open={found > 0 && at >= 0}>
					<span className="plan-research-found">
						<Swap id={String(shownFound)}>{shownFound}</Swap>{" "}
						{shownFound === 1 ? "source" : "sources"} found
					</span>
				</Fold>
			</Fold>
		</div>
	);
}

export function openResearch(
	store: ResearchStore,
	id: string,
	child: Research.ReadyChild,
	opener: HTMLElement,
): void {
	store.open(child, store.opener(id, opener));
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

function protectedResearch(node: LexicalNode, store: ResearchStore): boolean {
	if (!$isResearchNode(node)) return false;
	if (store.mutating(node.getId())) return true;
	let request = store.get(node.getId());
	return request === undefined || !REMOVABLE_STAGES.has(request.stage);
}

function edgeNode(node: LexicalNode | null, backward: boolean): LexicalNode | null {
	let current = node;
	while (current && $isElementNode(current) && current.getChildrenSize() > 0) {
		current = current.getChildAtIndex(backward ? current.getChildrenSize() - 1 : 0);
	}
	return current;
}

function adjacentNode(selection: RangeSelection, backward: boolean): LexicalNode | null {
	let point = selection.anchor;
	let node = point.getNode();
	if ($isElementNode(node)) {
		let child = node.getChildAtIndex(backward ? point.offset - 1 : point.offset);
		if (child) return edgeNode(child, backward);
		if (backward ? point.offset !== 0 : point.offset !== node.getChildrenSize()) return null;
	} else {
		let size = node.getTextContentSize();
		if (backward ? point.offset !== 0 : point.offset !== size) return null;
	}

	let current: LexicalNode | null = node;
	while (current) {
		let sibling = backward ? current.getPreviousSibling() : current.getNextSibling();
		if (sibling) return edgeNode(sibling, backward);
		current = current.getParent();
	}
	return null;
}

function protectsActiveResearch(store: ResearchStore, backward?: boolean): boolean {
	let selection = $getSelection();
	if ($isNodeSelection(selection)) {
		return selection.getNodes().some(node => protectedResearch(node, store));
	}
	if (!$isRangeSelection(selection)) return false;
	if (!selection.isCollapsed()) {
		return selection.getNodes().some(node => protectedResearch(node, store));
	}
	if (backward === undefined) return false;
	let adjacent = adjacentNode(selection, backward);
	return adjacent !== null && protectedResearch(adjacent, store);
}

export function registerResearchDeletion(editor: LexicalEditor, store: ResearchStore): () => void {
	return mergeRegister(
		editor.registerCommand(
			DELETE_CHARACTER_COMMAND,
			backward => protectsActiveResearch(store, backward),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			DELETE_WORD_COMMAND,
			backward => protectsActiveResearch(store, backward),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			DELETE_LINE_COMMAND,
			backward => protectsActiveResearch(store, backward),
			COMMAND_PRIORITY_HIGH,
		),
		editor.registerCommand(
			REMOVE_TEXT_COMMAND,
			() => protectsActiveResearch(store),
			COMMAND_PRIORITY_HIGH,
		),
	);
}

export function ResearchDeletionPlugin() {
	let [editor] = useLexicalComposerContext();
	let store = useCellValue(widgets$).research;
	useEffect(() => store ? registerResearchDeletion(editor, store) : undefined, [editor, store]);
	return null;
}

export type ResearchReferenceProps = {
	canEdit?: boolean;
	id: string;
	onRemove: () => void;
	store: ResearchStore;
};

export function subscribeResearch(store: ResearchStore, listener: () => void): () => void {
	return store.subscribe(listener);
}

export function retainResearch(store: ResearchStore, id: string): () => void {
	return store.retain(id);
}

export function ResearchReference({ canEdit = true, id, onRemove, store }: ResearchReferenceProps) {
	let subscribe = useCallback(
		(listener: () => void) => subscribeResearch(store, listener),
		[store],
	);
	let request = useSyncExternalStore(
		subscribe,
		() => store.get(id),
		() => store.get(id),
	);
	let mutating = useSyncExternalStore(
		subscribe,
		() => store.mutating(id),
		() => store.mutating(id),
	);
	let [busy, setBusy] = useState(false);
	let [actionError, setActionError] = useState<string>();

	useEffect(() => retainResearch(store, id), [id, store]);

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
			busy={busy || mutating}
			canEdit={canEdit}
			request={request}
			onCancel={actions.cancel ? () => action(() => store.cancel(request.id)) : undefined}
			onOpen={actions.open && request.child
				? opener => openResearch(store, request.id, request.child!, opener)
				: undefined}
			openButtonRef={button => store.opener(request.id, button)}
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
