/**
 * The focused questionnaire view.
 *
 * Unanswered cards stay in document order, because the first is where a room
 * resumes its work. Resolved history starts closed: it remains available without
 * making a long-lived room open below the questions that still need an answer.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { cardStatus } from "@chopin/dialect";
import { ChevronIcon, DecisionIcon } from "@chopin/icons";

import { MotionDisclosure, MotionDisclosureIcon } from "./disclosure-motion";
import { useQuestionnaires } from "./questionnaires";
import { QuestionnaireCard } from "./widgets/questionnaire";

import type { Question, VisualDecision } from "@chopin/protocol";
import type { CardMetaStore } from "./card-meta";
import type { Transport } from "@chopin/question/react";
import type { MotionDisclosureContract } from "./disclosure-motion";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";
import type { QuestionStepMotion } from "./widget-options";
import type { VisualPreviewComponent } from "./widgets/visual-decision";

export type DecisionsProps = {
	store: QuestionnaireStore;
	cardMeta?: CardMetaStore;
	canEdit?: boolean;
	motion: MotionDisclosureContract;
	motionImmediately?: () => boolean;
	questionMotion?: QuestionStepMotion;
	visualPreview?: VisualPreviewComponent;
	wire?: Transport;
	connected?: boolean;
	headingId?: string;
	/** Reveal the plan before taking the reader to a questionnaire's result. */
	onShowPlan?: (widget: string, question: string) => void;
	/**
	 * An item to bring into view.
	 *
	 * Carries a token as well as an id so asking for the same one twice still
	 * scrolls — naming it again means "show me", not "it is already open".
	 */
	reveal?: { widget: string; token: number };
};

let EMPTY_CARDS: ReadonlyMap<string, Question.CardMeta> = new Map();

function noop() {
	return () => {};
}

function emptyCards() {
	return EMPTY_CARDS;
}

function status(entry: QuestionnaireEntry, cardMeta: ReadonlyMap<string, Question.CardMeta>) {
	return cardMeta.get(entry.id)?.status ?? cardStatus(entry.value);
}

function waiting(entry: QuestionnaireEntry, cardMeta: ReadonlyMap<string, Question.CardMeta>) {
	let current = status(entry, cardMeta);
	return current === "open" || current === "reopened";
}

let HISTORY = "chopin:decisions:resolved";

/** Resolved history stays closed unless the reader explicitly opened it. */
function useHistory() {
	let [history, setHistory] = useState(() => localStorage.getItem(HISTORY) === "true");

	useEffect(() => {
		localStorage.setItem(HISTORY, String(history));
	}, [history]);

	return [history, setHistory] as const;
}

export function Decisions(
	{
		cardMeta,
		canEdit = true,
		connected,
		headingId,
		motion,
		motionImmediately,
		onShowPlan,
		questionMotion,
		visualPreview,
		reveal,
		store,
		wire,
	}: DecisionsProps,
) {
	let entries = useQuestionnaires(store);
	let readiness = useSyncExternalStore(
		store.subscribe,
		store.readinessSnapshot,
		store.readinessSnapshot,
	);
	let metadata = useSyncExternalStore(
		cardMeta?.subscribe ?? noop,
		cardMeta?.snapshot ?? emptyCards,
		cardMeta?.snapshot ?? emptyCards,
	);
	let content = useRef<HTMLDivElement>(null);
	let heading = useRef<HTMLHeadingElement>(null);
	let focusedQuestionnaire = useRef<HTMLElement | undefined>(undefined);
	let revealed = useRef<number | undefined>(undefined);
	let openVisual = useRef(new Set<string>());
	let [history, setHistory] = useHistory();
	let historyId = useId();
	let [creating, setCreating] = useState(false);
	let [createError, setCreateError] = useState<string>();
	let createPending = useRef(false);
	let create = async () => {
		if (!wire || !connected || !canEdit || createPending.current) return;
		createPending.current = true;
		setCreating(true);
		setCreateError(undefined);
		try {
			let result = await wire.ask("visual-decision:create", {}) as VisualDecision.Result;
			if (!result.ok) throw new Error("Decision not created");
		} catch {
			setCreateError("The decision could not be created. Try again.");
		} finally {
			createPending.current = false;
			setCreating(false);
		}
	};

	// Leaving the pane should not leave the prose lit. A highlight belongs to
	// the pointer that asked for it, and a pin to the pane that set it.
	useEffect(() => () => {
		store.release();
	}, [store]);

	useEffect(() => {
		let visual = entries.filter(entry => entry.value.visual === "decision-card-v1");
		// Keep a just-saved specimen and its attribution visible when it moves to history.
		if (
			visual.some(entry =>
				openVisual.current.has(entry.id) && status(entry, metadata) === "decided"
			)
		) {
			setHistory(true);
		}
		openVisual.current = new Set(
			visual.filter(entry => waiting(entry, metadata)).map(entry => entry.id),
		);
	}, [entries, metadata]);

	useEffect(() => {
		if (!reveal || revealed.current === reveal.token) return;
		revealed.current = reveal.token;
		let id = CSS.escape(reveal.widget);
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${id}"]`,
		);
		if (target) {
			target.scrollIntoView({ block: "center" });
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus();
	}, [entries, metadata, reveal]);

	// Removing a focused card sends focus to body without a blur event. Remember
	// the actual card so its removal can hand focus to the remaining work.
	useEffect(() => {
		let previous = focusedQuestionnaire.current;
		if (!previous || previous.isConnected || document.activeElement !== document.body) return;
		focusedQuestionnaire.current = undefined;
		let next = entries.find(entry => waiting(entry, metadata));
		let target = next
			? content.current?.querySelector<HTMLElement>(
				`[data-plan-sidecar-questionnaire="${CSS.escape(next.id)}"]`,
			)
			: undefined;
		if (target) {
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus({ preventScroll: true });
	}, [entries, metadata]);

	let pending = entries.filter(entry => waiting(entry, metadata));
	let settled = entries.filter(entry => !waiting(entry, metadata));

	let outstanding = pending.length;
	let resolved = settled.length;
	let empty = outstanding === 0 && resolved === 0;

	let question = (entry: QuestionnaireEntry) => (
		<QuestionnaireCard
			meta={metadata.get(entry.id)}
			canEdit={canEdit}
			connected={connected}
			key={entry.id}
			motion={questionMotion}
			visualPreview={visualPreview}
			onQuestionEnter={question => store.highlight(entry.id, question)}
			onQuestionLeave={() => store.clear()}
			onQuestionSelect={question => {
				if (onShowPlan) onShowPlan(entry.id, question);
				else store.reveal(entry.id, question);
			}}
			places={store.counts(entry.id)}
			presentation="list"
			value={entry.value}
			wire={wire}
		/>
	);

	return (
		<div className="plan-decisions">
			<h2 className="sr-only" id={headingId} ref={heading} tabIndex={-1}>Decisions</h2>
			{canEdit && (
				<div className="visual-decision-create">
					{createError && <span role="alert">{createError}</span>}
					<button
						className="btn btn-sm btn-outline"
						disabled={!connected || !wire || creating}
						onClick={() => void create()}
						type="button"
					>
						{creating ? "Creating…" : "Tune decision card"}
					</button>
				</div>
			)}

			<div
				className={`plan-decisions-content min-h-0 flex-1 overflow-auto${
					empty ? " plan-decisions-content--empty" : ""
				}`}
				data-plan-decisions-scroll=""
				onBlurCapture={event => {
					let next = event.relatedTarget;
					if (next instanceof Node && !event.currentTarget.contains(next)) {
						focusedQuestionnaire.current = undefined;
					}
				}}
				onFocusCapture={event => {
					focusedQuestionnaire.current = (event.target as HTMLElement).closest<HTMLElement>(
						"[data-plan-sidecar-questionnaire]",
					) ?? undefined;
				}}
				ref={content}
			>
				{empty
					? (
						<div className="plan-decisions-empty">
							<span className="plan-decisions-empty-icon" aria-hidden="true">
								<DecisionIcon size={24} />
							</span>
							<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
								{readiness === "ready"
									? "No decisions yet"
									: readiness === "unavailable"
									? "Decisions unavailable"
									: "Loading decisions"}
							</span>
							{readiness === "ready"
								? (
									<>
										<h3>No decisions yet</h3>
										<p>
											Questions from Chopin will appear here, with your answers kept for reference.
										</p>
									</>
								)
								: readiness === "unavailable"
								? (
									<>
										<h3>Decisions unavailable</h3>
										<p>The document couldn’t be opened. Try again to load its decisions.</p>
										<button
											className="btn btn-sm btn-secondary mt-6"
											onClick={() => store.retryOpen()}
											type="button"
										>
											Try again
										</button>
									</>
								)
								: <p aria-hidden="true">Loading decisions…</p>}
						</div>
					)
					: (
						<div className="flex flex-col gap-3">
							{pending.map(question)}
						</div>
					)}

				{resolved > 0 && (
					<div className={`min-w-0 ${outstanding > 0 ? "mt-3" : ""}`}>
						<button
							aria-controls={history ? historyId : undefined}
							aria-expanded={history}
							className="btn btn-sm btn-ghost h-auto min-h-6 w-full flex-wrap justify-start gap-2 text-left"
							data-press="wide"
							onClick={() => setHistory(value => !value)}
							type="button"
						>
							<MotionDisclosureIcon
								className="editor-motion-feedback"
								closed={<ChevronIcon size={14} />}
								open={history}
								opened={<ChevronIcon className="rotate-90" size={14} />}
							/>
							<span className="tabular-nums">{resolved}</span>
							<span>resolved</span>
						</button>
						<MotionDisclosure
							className="plan-decision-history-motion"
							id={historyId}
							immediately={motionImmediately?.() ?? false}
							motion={motion}
							open={history}
							surface="decision-history"
						>
							<div className="mt-2 flex flex-col gap-3">
								{settled.map(question)}
							</div>
						</MotionDisclosure>
					</div>
				)}
			</div>
		</div>
	);
}
