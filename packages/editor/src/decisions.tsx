/**
 * The focused questionnaire view.
 *
 * Unanswered cards stay in document order, because the first is where a room
 * resumes its work. Resolved history starts closed: it remains available without
 * making a long-lived room open below the questions that still need an answer.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { cardStatus } from "@chopin/dialect";
import { CheckIcon, ChevronIcon, DecisionIcon } from "@chopin/icons";
import { EmptyState } from "@chopin/visuals";

import { decisionsDeck } from "./decision-state";
import { Deck, revealDeckItem } from "./deck";
import { MotionDisclosure, MotionDisclosureIcon } from "./disclosure-motion";
import { usePhone } from "./pointer";
import { useQuestionnaires } from "./questionnaires";
import { PendingAnswersContext, PendingAnswersStore, SaveBar } from "./save-bar";
import { forget } from "./touched";
import { labels, QuestionnaireCard } from "./widgets/questionnaire";

import type { Question } from "@chopin/protocol";
import type { ReactNode } from "react";
import type { CardMetaStore } from "./card-meta";
import type { Transport } from "@chopin/question/react";
import type { MotionDisclosureContract } from "./disclosure-motion";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";
import type { QuestionStepMotion } from "./widget-options";

export type DecisionsProps = {
	additional?: ReactNode;
	hasAdditional?: boolean;
	store: QuestionnaireStore;
	cardMeta?: CardMetaStore;
	canEdit?: boolean;
	/** The viewer's own handle, who is never shown as present on a card. */
	self?: string;
	/** False when no Planner will review where decisions live. */
	planner?: boolean;
	motion: MotionDisclosureContract;
	motionImmediately?: () => boolean;
	questionMotion?: QuestionStepMotion;
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
	 * `resume` means the tab itself was chosen: a deck keeps its current top
	 * rather than bringing the named card forward.
	 */
	reveal?: { widget: string; token: number; resume?: boolean };
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

/** How long a just-decided card holds its confirmation before it folds away. */
export const CONFIRM_MS = 1100;
/** Matches `--decision-closure-dur` on `.decision-confirmed-collapse`. */
export const COLLAPSE_MS = 320;

/** A decision this client saved holds a confirmation; anyone else's just folds away. */
type Closing = { phase: "confirmed" | "leaving" | "collapsing"; mine: boolean };

/**
 * Cards that just left the open list because they were decided.
 *
 * Driven by the card status the server publishes after its commit, never by a
 * local Save press, so the confirmation cannot run ahead of persistence.
 */
export function newlyDecided(
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
	decided: (id: string) => boolean,
): string[] {
	return [...before].filter(id => !after.has(id) && decided(id));
}

function useClosing(
	enabled: boolean,
	open: ReadonlySet<string>,
	decided: (id: string) => boolean,
	mine: (id: string) => boolean,
	immediately: () => boolean,
) {
	let [closing, setClosing] = useState<ReadonlyMap<string, Closing>>(new Map());
	let before = useRef<ReadonlySet<string> | undefined>(undefined);
	let timers = useRef(new Set<number>());
	let key = [...open].join("\n");

	useEffect(() => {
		let previous = before.current;
		before.current = open;
		if (!enabled || !previous) return;
		let fresh = newlyDecided(previous, open, decided);
		if (fresh.length === 0) return;
		let update = (id: string, closing: Closing | undefined) =>
			setClosing(current => {
				let next = new Map(current);
				if (closing) next.set(id, closing);
				else next.delete(id);
				return next;
			});
		let later = (delay: number, action: () => void) => {
			let timer = window.setTimeout(() => {
				timers.current.delete(timer);
				action();
			}, delay);
			timers.current.add(timer);
		};
		let still = immediately();
		for (let id of fresh) {
			let own = mine(id);
			if (own) {
				update(id, { phase: "confirmed", mine: true });
				if (still) later(CONFIRM_MS, () => update(id, undefined));
				else {
					later(CONFIRM_MS, () => update(id, { phase: "collapsing", mine: true }));
					later(CONFIRM_MS + COLLAPSE_MS, () => update(id, undefined));
				}
			} else if (!still) {
				// Someone else's decision: no hold, only the fold, so the list does not jump.
				update(id, { phase: "leaving", mine: false });
				later(LEAVE_MS, () => update(id, { phase: "collapsing", mine: false }));
				later(LEAVE_MS + COLLAPSE_MS, () => update(id, undefined));
			}
		}
		// `key` stands for `open`, which is rebuilt every render.
	}, [enabled, key]);

	useEffect(() => () => {
		for (let timer of timers.current) window.clearTimeout(timer);
	}, []);

	return closing;
}

/** Long enough for the folding card to paint open before it collapses. */
const LEAVE_MS = 50;

/** "You" for this viewer, otherwise the resolver's handle; absent when unknown. */
export function decidedBy(resolver: string | undefined, self: string | undefined) {
	if (!resolver || resolver === "system") return undefined;
	return resolver === self ? "You" : `@${resolver}`;
}

function Confirmed(
	{ by, closing, entry }: { by?: string; closing: Closing; entry: QuestionnaireEntry },
) {
	let chosen = labels(entry.value);
	let question = entry.value.questions.map(item => item.prompt).join(" · ");
	return (
		<div
			aria-hidden={closing.mine ? undefined : true}
			className={`decision-confirmed-collapse${
				closing.phase === "collapsing" ? " is-closing" : ""
			}`}
			data-decision-confirmed={entry.id}
			data-mine={closing.mine ? "" : undefined}
		>
			<div className="min-h-0 overflow-hidden">
				<div className="decision-confirmed" role={closing.mine ? "status" : undefined}>
					<span aria-hidden="true" className="decision-confirmed-mark">
						<CheckIcon />
					</span>
					<span className="decision-confirmed-text">
						<span className="decision-confirmed-label">
							{by ? `Decided · ${by}` : "Decided"}
						</span>
						<span className="decision-confirmed-question">{question}</span>
						<span className="decision-confirmed-answer">
							{chosen.length ? chosen.join(", ") : "Saved decision"}
						</span>
					</span>
				</div>
			</div>
		</div>
	);
}

export function Decisions(
	{
		additional,
		hasAdditional = false,
		cardMeta,
		canEdit = true,
		connected,
		headingId,
		motion,
		motionImmediately,
		onShowPlan,
		planner,
		questionMotion,
		reveal,
		self,
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
	let [history, setHistory] = useHistory();
	let historyId = useId();

	// Leaving the pane should not leave the prose lit. A highlight belongs to
	// the pointer that asked for it, and a pin to the pane that set it.
	useEffect(() => () => {
		store.release();
	}, [store]);

	useEffect(() => {
		if (!reveal || revealed.current === reveal.token) return;
		revealed.current = reveal.token;
		let id = CSS.escape(reveal.widget);
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${id}"]`,
		);
		if (target) {
			let inDeck = target.closest<HTMLElement>("[data-deck]");
			if (inDeck && !reveal.resume) revealDeckItem(target);
			let focusTarget = inDeck?.querySelector<HTMLElement>("[data-deck-top]") ?? target;
			focusTarget.scrollIntoView({ block: "center" });
			focusTarget.tabIndex = -1;
			focusTarget.focus({ preventScroll: true });
		} else heading.current?.focus();
	}, [entries, metadata, reveal]);

	// Removing a focused card sends focus to body without a blur event. Remember
	// the actual card so its removal can hand focus to the remaining work.
	useEffect(() => {
		let previous = focusedQuestionnaire.current;
		if (!previous || previous.isConnected || document.activeElement !== document.body) return;
		focusedQuestionnaire.current = undefined;
		let next = entries.find(entry => waiting(entry, metadata));
		let card = next
			? content.current?.querySelector<HTMLElement>(
				`[data-plan-sidecar-questionnaire="${CSS.escape(next.id)}"]`,
			)
			: undefined;
		// A card behind a deck's top is inert, so the deck's top takes focus instead.
		let target = card?.closest<HTMLElement>("[data-deck]")?.querySelector<HTMLElement>(
			"[data-deck-top]",
		) ?? card;
		if (target) {
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus({ preventScroll: true });
	}, [entries, metadata]);

	let phone = usePhone();
	let [pendingAnswers] = useState(() => new PendingAnswersStore());
	let open = new Set(entries.filter(entry => waiting(entry, metadata)).map(entry => entry.id));
	let closing = useClosing(
		phone,
		open,
		id => metadata.get(id)?.status === "decided",
		id => {
			let resolver = metadata.get(id)?.resolver;
			return pendingAnswers.savedHere(id) && (!resolver || resolver === self);
		},
		() => motionImmediately?.() ?? false,
	);
	let following = useRef<() => void>(undefined);
	useEffect(() => () => following.current?.(), []);
	let showCard = useCallback((card: string) => {
		let list = content.current;
		let target = list?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${CSS.escape(card)}"]`,
		);
		if (!list || !target) return;
		target.scrollIntoView({ block: "center" });
		target.tabIndex = -1;
		target.focus({ preventScroll: true });
		// A card saved alongside it can fold away above it afterwards and pull it
		// out of view. Follow it through layout changes while it still shows its
		// error or keeps focus.
		following.current?.();
		let frame = 0;
		let observer = new ResizeObserver(() => {
			let attending = !!target.querySelector('[role="alert"]')
				|| document.activeElement === target;
			if (!target.isConnected || !attending) {
				following.current?.();
				return;
			}
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => target.scrollIntoView({ block: "center" }));
		});
		for (let child of list.children) observer.observe(child);
		let expiry = window.setTimeout(() => following.current?.(), 10_000);
		following.current = () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			window.clearTimeout(expiry);
			following.current = undefined;
		};
	}, []);
	let focusRemaining = useCallback(() => {
		let next = content.current?.querySelector<HTMLElement>(
			"[data-plan-sidecar-questionnaire]",
		);
		if (next) {
			next.tabIndex = -1;
			next.focus({ preventScroll: true });
		} else heading.current?.focus({ preventScroll: true });
	}, []);

	// A decided or discarded card has nothing left of this person's to save.
	let settledKey = entries.filter(entry => !open.has(entry.id)).map(entry => entry.id).join("\n");
	useEffect(() => {
		for (let id of settledKey.split("\n")) if (id) forget(id);
	}, [settledKey]);

	let pending = entries.filter(entry => open.has(entry.id) || closing.has(entry.id));
	let settled = entries.filter(entry => !open.has(entry.id) && !closing.has(entry.id));

	// Cards open at some point in this mount, so one answered here waits in the deck.
	let [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
	let openKey = [...open].join("\n");
	useEffect(() => {
		if ([...open].every(id => seen.has(id))) return;
		setSeen(previous => new Set([...previous, ...open]));
		// `openKey` stands for `open`, which is rebuilt every render.
	}, [openKey]);
	// Phones keep the one-pane list and its save bar.
	let arranged = phone
		? { deck: [], answered: [], history: settled.map(entry => entry.id) }
		: decisionsDeck(
			pending.map(entry => entry.id),
			settled.map(entry => entry.id),
			new Set([...seen, ...open]),
		);
	let byId = new Map(entries.map(entry => [entry.id, entry]));
	let answeredHere = new Set(arranged.answered);
	let listed = settled.filter(entry => !answeredHere.has(entry.id));

	let outstanding = pending.length;
	// Settled cards not waiting in the deck; a folding card already counts as resolved.
	let resolved = listed.length + closing.size;
	let empty = outstanding === 0 && resolved === 0 && !hasAdditional;

	let question = (entry: QuestionnaireEntry) => (
		<QuestionnaireCard
			meta={metadata.get(entry.id)}
			planner={planner}
			relations={store.relations(entry.id)}
			canEdit={canEdit}
			connected={connected}
			key={entry.id}
			motion={questionMotion}
			onQuestionEnter={question => store.highlight(entry.id, question)}
			onQuestionLeave={() => store.clear()}
			onQuestionSelect={question => {
				if (onShowPlan) onShowPlan(entry.id, question);
				else store.reveal(entry.id, question);
			}}
			places={store.counts(entry.id)}
			presentation="list"
			self={self}
			value={entry.value}
			wire={wire}
		/>
	);

	let pane = (
		<div className="plan-decisions" data-phone={phone ? "" : undefined}>
			<h2 className="sr-only" id={headingId} ref={heading} tabIndex={-1}>Decisions</h2>

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
				{additional}
				{empty
					? (
						<>
							<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
								{readiness === "ready"
									? "No decisions yet"
									: readiness === "unavailable"
									? "Decisions unavailable"
									: "Loading decisions"}
							</span>
							<EmptyState
								appearance="framed"
								density="compact"
								icon={DecisionIcon}
								title={readiness === "ready"
									? "No decisions yet"
									: readiness === "unavailable"
									? "Decisions unavailable"
									: undefined}
								description={readiness === "ready"
									? "Questions from Chopin will appear here, with your answers kept for reference."
									: readiness === "unavailable"
									? "The document couldn’t be opened. Try again to load its decisions."
									: <span aria-hidden="true">Loading decisions…</span>}
								action={readiness === "unavailable" && (
									<button
										className="btn btn-sm btn-secondary"
										onClick={() => store.retryOpen()}
										type="button"
									>
										Try again
									</button>
								)}
							/>
						</>
					)
					: arranged.deck.length > 0
					? (
						<Deck
							label={`${pending.length} open ${pending.length === 1 ? "decision" : "decisions"}`}
							onLeave={() => focusRemaining()}
							items={arranged.deck.flatMap(id => {
								let entry = byId.get(id);
								return entry
									? [{
										id,
										settled: answeredHere.has(id),
										label: entry.value.questions[0]?.header ?? "Decision",
										card: question(entry),
									}]
									: [];
							})}
						/>
					)
					: (
						<div className="flex flex-col gap-3">
							{pending.map(entry => {
								let phase = closing.get(entry.id);
								return phase
									? (
										<Confirmed
											by={decidedBy(metadata.get(entry.id)?.resolver, self)}
											closing={phase}
											entry={entry}
											key={entry.id}
										/>
									)
									: question(entry);
							})}
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
							<span className="tabular-nums">{`${resolved} resolved`}</span>
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
								{listed.map(question)}
							</div>
						</MotionDisclosure>
					</div>
				)}
			</div>
			{phone && (
				<SaveBar
					onFailed={showCard}
					onFocusLeave={focusRemaining}
					onIncomplete={showCard}
					store={pendingAnswers}
				/>
			)}
		</div>
	);
	return (
		<PendingAnswersContext.Provider value={phone ? pendingAnswers : undefined}>
			{pane}
		</PendingAnswersContext.Provider>
	);
}
