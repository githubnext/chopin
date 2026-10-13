/**
 * A questionnaire, as the decisions pane shows it.
 *
 * The definition only ever grows by appended options and the answer is owned by
 * the server's record, so this never writes to the document — an agent rewriting the plan cannot
 * overwrite a decision. What the plan node carries is a projection, kept so
 * the source reads correctly on its own.
 */

import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cardStatus } from "@chopin/dialect";
import { ChevronIcon, DecisionIcon, MessageForwardIcon } from "@chopin/icons";
import {
	cardRelation,
	NOT_LINKED,
	QuestionView,
	RelationNote,
	useQuestionnaire,
} from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { Provenance, SidecarCard } from "../card";
import { useCardMeta } from "../card-meta";
import { ContentSwapLayer } from "../content-swap";
import { Deck } from "../deck";
import { deckLayout } from "../deck-runs";
import { EvidenceHover, EvidenceTrigger } from "./evidence-hover";
import { PresenceFaces, withoutSelf } from "../presence-faces";
import { usePhone } from "../pointer";
import { PendingAnswersContext } from "../save-bar";
import { forget, remember, selectionOf, stillMine, useSelections, withChange } from "../touched";
import { useRelations } from "../questionnaires";
import { widgets$ } from "../widget-options";
import { useTransitionPresence } from "../transition-presence";
import { WriteupStatus } from "./writeup-status";

import type { Question } from "@chopin/protocol";
import type { ReactNode } from "react";
import type { Transport } from "@chopin/question/react";
import type { Answer, Relation } from "@chopin/question";
import type { Questionnaire, QuestionnaireNode } from "@chopin/dialect";
import type { QuestionStepMotion } from "../widget-options";
import type { MemberState } from "../deck-runs";
import type { QuestionnaireEntry, QuestionnaireStore } from "../questionnaires";

/** The plan stores the chosen text; the shared view wants answer records. */
function answers(value: Questionnaire): Answer[] | undefined {
	if (value.questions.some(question => question.answer === undefined)) return undefined;
	return value.questions.map(question =>
		question.choices?.length
			? {
				question: question.prompt,
				choices: question.options
					.filter(option => question.choices!.includes(option.id))
					.map(option => option.label),
				optionIds: question.choices,
			}
			: { question: question.prompt, custom: question.answer ?? "" }
	);
}

/** The document calls the question text `prompt`; the domain calls it `question`. */
function definition(value: Questionnaire) {
	return {
		questions: value.questions.map(question => ({
			id: question.id,
			header: question.header,
			question: question.prompt,
			multiple: question.multiple,
			options: question.options.map(option => ({
				id: option.id,
				label: option.label,
				description: option.description ?? "",
			})),
		})),
	};
}

export type QuestionnaireCardProps = {
	value: Questionnaire;
	/** Durable lifecycle state can arrive separately from the document node. */
	meta?: Question.CardMeta;
	presentation?: "inline" | "deck" | "list";
	motionImmediately?: () => boolean;
	onCardSource?: (questionnaireId: string) => void;
	/** The viewer's own handle, who is never shown as present on a card. */
	self?: string;
	evidence?: ReactNode | null;
	wire?: Transport;
	connected?: boolean;
	/** Whether this viewer may change or resolve the shared draft. */
	canEdit?: boolean;
	/** How much prose each decision lives in. */
	places?: { [question: string]: number };
	/** Linked, pending, deliberately empty or orphaned, by question. */
	relations?: { [question: string]: Relation };
	/** False when no Planner will review where decisions live. */
	planner?: boolean;
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
	/** Take the reader to that prose. Without it the shared view's jump is inert. */
	onQuestionSelect?: (question: string) => void;
	motion?: QuestionStepMotion;
	/** How many hidden decisions are being written up, when this card speaks for them all. */
	writing?: number;
};

export type CardPresentation = "hidden" | "settled-line" | "resolved" | "open";

/**
 * How a card shows where it is.
 *
 * In the document a decided card is shown only through the prose it lives in:
 * pending, deliberately empty and orphaned decisions have no prose to mark, so
 * they stay out of the reading flow and keep their full card in Decisions. The
 * projection node itself stays; this only decides what its decorator draws. A
 * deck keeps its decided members at full size while it holds an open one.
 */
export function cardPresentation(
	value: Questionnaire,
	meta: Question.CardMeta | undefined,
	where: "inline" | "deck" | "list",
): CardPresentation {
	let status = meta?.status ?? cardStatus(value);
	if (status === "open" || status === "reopened") return "open";
	if (where === "list") return "resolved";
	if (where === "inline" || status === "discarded" || meta?.hasProse) return "hidden";
	// In a deck a decided card keeps an open card's footprint, so the stack never shrinks to a line.
	return "resolved";
}

/**
 * Whether a decision the document hides is having its prose written right now.
 *
 * Only work that is actually running counts: a conversation decision's write-up
 * job, or a Planner turn that owes this decision a review and has no prose for
 * it yet. Deliberately empty and orphaned decisions wait on nothing.
 */
export function writingProse(
	value: Questionnaire,
	meta: Question.CardMeta | undefined,
	work: { unwritten: boolean; plannerBusy: boolean },
): boolean {
	if (value.status === "expired" || cardPresentation(value, meta, "inline") !== "hidden") {
		return false;
	}
	if ((meta?.status ?? cardStatus(value)) !== "decided" || meta?.hasProse) return false;
	if (meta?.proseOrphaned) return false;
	if (meta?.origin === "conversation") return meta.writeup?.status === "writing";
	return work.plannerBusy && work.unwritten;
}

/** One quiet line where prose is about to land, however many decisions it is for. */
function WritingUp({ count, id }: { count: number; id: string }) {
	return (
		<p
			className="m-0 flex items-center gap-1.5 text-sm text-text-tertiary"
			data-plan-sidecar-questionnaire={id}
			data-plan-writing-up=""
			role="status"
		>
			<span aria-hidden="true" className="plan-research-dot" />
			{count === 1 ? "Writing up a decision…" : `Writing up ${count} decisions…`}
		</p>
	);
}

export function QuestionnaireCard(
	{
		canEdit = true,
		connected = false,
		evidence,
		motionImmediately,
		onCardSource,
		presentation = "inline",
		self,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
		motion,
		meta,
		places,
		planner = true,
		relations,
		value,
		wire,
		writing,
	}: QuestionnaireCardProps,
) {
	if (value.status === "expired") return <Expired value={value} />;
	let resolved = answers(value);
	let current = meta?.status ?? cardStatus(value);
	// A conversation decision's write-up has its own durable job status below.
	// "Linking…" is anchor review, which needs a Planner.
	let pendingRelation = meta?.origin === "conversation" && !meta.hasProse
		? NOT_LINKED
		: planner
		? "Linking…"
		: NOT_LINKED;
	let pointing = {
		places,
		relations,
		pendingRelation,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
	};

	let shown = cardPresentation(value, meta, presentation);
	let immediate = motionImmediately?.() ?? false;
	let presence = useTransitionPresence(shown === "hidden" ? undefined : value.id, 200, immediate);
	let lastVisible = useRef<{ id: string; content: ReactNode } | undefined>(undefined);
	let content = shown === "settled-line"
		? (
			<SettledLine
				canEdit={canEdit}
				connected={connected}
				meta={meta}
				value={value}
				wire={wire}
				{...pointing}
			/>
		)
		: shown === "resolved"
		? (
			<Decided
				canEdit={canEdit}
				connected={connected}
				wire={wire}
				discarded={current === "discarded"}
				meta={meta}
				resolved={resolved}
				value={value}
				{...pointing}
			/>
		)
		: (
			<Undecided
				onCardSource={onCardSource}
				self={self}
				canEdit={canEdit}
				connected={connected}
				motion={motion}
				meta={meta}
				value={value}
				wire={wire}
				{...pointing}
			/>
		);
	if (shown !== "hidden") lastVisible.current = { id: value.id, content };
	let closing = shown === "hidden"
		&& presence.phase === "closing"
		&& lastVisible.current?.id === presence.value;
	if (shown === "hidden" && !closing) {
		if (writing) return <WritingUp count={writing} id={value.id} />;
		return (
			<div
				data-plan-sidecar-questionnaire={value.id}
				data-card-hidden=""
				data-plan-collapsed=""
				hidden
			/>
		);
	}
	if (presentation === "list") return content;
	let presented = closing ? lastVisible.current!.content : content;
	let evidenceActive = (current === "open" || current === "reopened")
		&& !!value.thread
		&& (meta?.status === "open" || meta?.status === "reopened")
		&& !!evidence;
	return (
		<EvidenceHover
			active={evidenceActive}
			content={evidence ?? null}
			question={value.questions[0]?.prompt ?? "this decision"}
		>
			<div
				aria-hidden={closing || undefined}
				className={`decision-collapse ${presence.className}`}
				data-decision-collapsing={closing ? presence.value : undefined}
				inert={closing}
			>
				<div className={`min-h-0${closing ? " overflow-hidden" : ""}`}>{presented}</div>
			</div>
		</EvidenceHover>
	);
}

type Pointing = {
	places?: { [question: string]: number };
	relations?: { [question: string]: Relation };
	pendingRelation?: string;
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
	onQuestionSelect?: (question: string) => void;
};

type QuestionStep = { children: ReactNode; question: string };

function QuestionStepSwap(
	{ children, motion, question }: {
		children: ReactNode;
		motion: QuestionStepMotion;
		question: string;
	},
) {
	let current = useRef<QuestionStep>({ children, question });
	let immediately = motion.immediately();
	let [presented, setPresented] = useState(question);
	let [active, setActive] = useState(question);
	let [outgoing, setOutgoing] = useState<QuestionStep>();
	if (presented !== question) {
		setOutgoing(current.current);
		setPresented(question);
		if (immediately) setActive(question);
	}
	current.current = { children, question };
	useEffect(() => {
		if (active !== question) setActive(question);
	}, [active, question]);

	return (
		<div className="question-step-swap content-swap-stack" data-question-step-swap>
			{outgoing && (
				<ContentSwapLayer
					active={false}
					className="question-step-layer"
					immediately={immediately}
					key={outgoing.question}
					motion={motion.contract}
					onClosed={() =>
						setOutgoing(step => step?.question === outgoing.question ? undefined : step)}
				>
					{outgoing.children}
				</ContentSwapLayer>
			)}
			<ContentSwapLayer
				active={active === presented}
				className="question-step-layer"
				immediately={immediately}
				key={presented}
				motion={motion.contract}
			>
				{children}
			</ContentSwapLayer>
		</div>
	);
}

function Undecided(
	{ canEdit, connected, meta, motion, onCardSource, self, value, wire, ...pointing }:
		& {
			canEdit: boolean;
			connected: boolean;
			meta?: Question.CardMeta;
			motion?: QuestionStepMotion;
			onCardSource?: (questionnaireId: string) => void;
			self?: string;
			value: Questionnaire;
			wire?: Transport;
		}
		& Pointing,
) {
	let state = useQuestionnaire({
		id: value.id,
		bridge: wire,
		connected: connected && canEdit,
		definition: definition(value),
	});

	let answerable = connected && !!state.definition;
	let editable = canEdit && answerable;
	let previous = previousAnswers(value);
	let pending = useContext(PendingAnswersContext);
	// Counted in the save bar only while the shared draft still says what this person chose.
	let selections = useSelections(value.id);
	let touched = stillMine(selections, state.drafts);

	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
		>
			<QuestionView
				headerActions={
					<>
						<EvidenceTrigger />
						{meta?.thread && onCardSource && (
							<button
								aria-label="Show source in chat"
								className="btn btn-icon btn-ghost"
								onClick={() => onCardSource(value.id)}
								type="button"
							>
								<MessageForwardIcon aria-hidden="true" size={14} />
							</button>
						)}
					</>
				}
				collaborators={state.collaborators}
				definition={state.definition ?? definition(value)}
				// A draft that has not synced cannot be edited without discarding
				// what other people have already put into it.
				disabled={!editable || state.syncing || state.submitting}
				drafts={state.drafts}
				error={state.error}
				errorClassName="editor-motion-feedback"
				suggested={meta?.suggested}
				refining={meta?.refining}
				previous={previous}
				onAddOption={editable ? state.addOption : undefined}
				onDiscard={editable ? state.discard : undefined}
				onChange={editable ? state.change : undefined}
				onQuestionFocus={editable ? state.focusQuestion : undefined}
				onSubmit={editable
					? suggestion => {
						pending?.submitted(value.id);
						state.submit(suggestion);
					}
					: undefined}
				renderPeople={people => (
					<PresenceFaces
						handles={withoutSelf(
							[...(meta?.involved ?? []), ...people.map(person => person.handle)],
							self,
						)}
						label={meta ? "In this decision" : undefined}
					/>
				)}
				renderStep={motion
					? ({ children, question }) => (
						<QuestionStepSwap motion={motion} question={question}>
							{children}
						</QuestionStepSwap>
					)
					: undefined}
				status="open"
				submitting={state.submitting}
				deferSave={!!pending}
				touched={pending ? touched : undefined}
				onTouchedChange={pending ? () => forget(value.id) : undefined}
				onLocalChange={pending
					? (question, change) =>
						remember(value.id, question, selectionOf(withChange(state.drafts[question], change)))
					: undefined}
				onPending={pending && (answers => pending.set(value.id, answers))}
				{...pointing}
			/>
		</SidecarCard>
	);
}

function previousAnswers(value: Questionnaire) {
	let previous: Record<string, { labels: string[]; by: string }> = {};
	for (let question of value.questions) {
		if (!question.previous) continue;
		let labels = question.previous.choices.flatMap(id => {
			let option = question.options.find(candidate => candidate.id === id);
			return option ? [option.label] : [];
		});
		if (labels.length === 0 && question.previous.value) labels = [question.previous.value];
		previous[question.id] = { labels, by: question.previous.by };
	}
	return Object.keys(previous).length === 0 ? undefined : previous;
}

/** The chosen answers' labels, as the document projection records them. */
export function labels(value: Questionnaire): string[] {
	return value.questions.flatMap(question => {
		let selected = question.choices?.flatMap(id => {
			let option = question.options.find(candidate => candidate.id === id);
			return option ? [option.label] : [];
		});
		return selected?.length ? selected : question.answer ? [question.answer] : [];
	});
}

function SettledLine(
	{ canEdit, connected, meta, value, wire, ...pointing }: {
		canEdit: boolean;
		connected: boolean;
		meta?: Question.CardMeta;
		value: Questionnaire;
		wire?: Transport;
	} & Pointing,
) {
	let owner = meta?.owner ?? value.by;
	let chosen = labels(value);
	let first = value.questions[0]?.id;
	let related = meta?.proseOrphaned && first
		? { relation: "orphaned" as const, question: first }
		: cardRelation(pointing.relations, value.questions.map(question => question.id))
			?? (meta?.origin === "conversation" && first
				? { relation: "pending" as const, question: first }
				: undefined);
	let writeup = related?.relation === "pending" && meta?.origin === "conversation"
		&& (meta.writeup?.status === "writing" || meta.writeup?.status === "failed");
	let state = useQuestionnaire({
		id: value.id,
		bridge: wire,
		connected: canEdit && connected,
		definition: definition(value),
	});
	let [error, setError] = useState<string>();
	let [reopening, setReopening] = useState(false);
	let reopen = async () => {
		setError(undefined);
		setReopening(true);
		let result = await state.reopen();
		if (!result.ok) setError(result.message);
		setReopening(false);
	};
	return (
		<p
			className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary"
			data-card-settled=""
			data-plan-sidecar-questionnaire={value.id}
		>
			<DecisionIcon aria-hidden="true" className="icon-first-line" size={14} />
			<span>
				Decided: {chosen.length ? chosen.join(", ") : "Saved decision"}
				{owner ? ` · @${owner}` : ""}
			</span>
			{writeup && meta
				? <WriteupStatus canEdit={canEdit} connected={connected} meta={meta} wire={wire} />
				: related && (
					<RelationNote
						count={pointing.places?.[related.question]}
						onEnter={pointing.onQuestionEnter}
						onLeave={pointing.onQuestionLeave}
						onSelect={pointing.onQuestionSelect}
						pending={pointing.pendingRelation}
						question={related.question}
						relation={related.relation}
					/>
				)}
			{related?.relation === "orphaned" && (
				<button
					className="btn btn-sm btn-secondary ml-auto"
					disabled={!canEdit || !connected || reopening}
					onClick={() => void reopen()}
					type="button"
				>
					Reopen
				</button>
			)}
			{error && <span className="text-text-tertiary" role="alert">{error}</span>}
		</p>
	);
}

function Decided(
	{ canEdit, connected, discarded, meta, resolved, value, wire, ...pointing }: {
		canEdit: boolean;
		connected: boolean;
		discarded: boolean;
		meta?: Question.CardMeta;
		resolved: Answer[] | undefined;
		value: Questionnaire;
		wire?: Transport;
	} & Pointing,
) {
	let [error, setError] = useState<string>();
	let [submitting, setSubmitting] = useState(false);
	let pending = useRef(false);
	let editable = canEdit && connected && !!wire && !discarded;
	let request = (kind: "question:reopen" | "question:discard") => {
		if (!wire || pending.current) return;
		pending.current = true;
		setSubmitting(true);
		setError(undefined);
		void wire.ask(kind, { id: value.id })
			.then((reply: unknown) => {
				if ((reply as { ok?: boolean }).ok) return;
				setError(
					kind === "question:reopen"
						? "Could not reopen it. Try again."
						: "Could not discard this decision.",
				);
			})
			.catch(() =>
				setError(
					kind === "question:reopen"
						? "Could not reopen it. Try again."
						: "Could not discard this decision.",
				)
			)
			.finally(() => {
				pending.current = false;
				setSubmitting(false);
			});
	};
	// Metadata owns lifecycle attribution; older nodes retain their document fallback.
	let resolver = meta ? meta.resolver : value.by;
	let provenance = resolver && (
		<Provenance
			at={meta ? meta.decidedAt : value.at}
			by={resolver}
			verb={discarded ? "Discarded" : "Answered"}
		/>
	);
	// The document hides a decision without prose, so its write-up's progress and Retry live
	// here until the paragraph lands.
	let linked = cardRelation(pointing.relations, value.questions.map(question => question.id))
		?.relation === "linked";
	let writeup = !discarded && !linked && meta?.origin === "conversation" && !meta.hasProse
		&& !meta.proseOrphaned && !!meta.writeup;
	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
			settled={discarded}
			status={discarded ? provenance : undefined}
		>
			<QuestionView
				answers={resolved}
				aside={discarded ? undefined : provenance}
				definition={definition(value)}
				disabled={!editable}
				drafts={{}}
				error={error}
				errorClassName="editor-motion-feedback"
				onDiscard={editable ? () => request("question:discard") : undefined}
				onReopen={editable ? () => request("question:reopen") : undefined}
				relationNote={writeup && meta
					? <WriteupStatus canEdit={canEdit} connected={connected} meta={meta} wire={wire} />
					: undefined}
				resolver={discarded ? meta?.resolver : undefined}
				status={discarded ? "discarded" : "answered"}
				submitting={submitting}
				{...pointing}
			/>
		</SidecarCard>
	);
}

/**
 * Whether a resolved decision is carried entirely by a margin marker.
 *
 * Only when every question has prose to sit beside. Pending, deliberately
 * empty and orphaned decisions have nowhere to put a marker, so they keep a
 * compact card rather than vanishing from the plan.
 */
export function carriedByMarkers(
	value: Questionnaire,
	places: { [question: string]: number } | undefined,
): boolean {
	return !!places
		&& value.questions.length > 0
		&& value.questions.every(question =>
			question.answer !== undefined && (places[question.id] ?? 0) > 0
		);
}

/** Host input nobody answered in time: settled like an answer, with nothing to submit. */
function Expired({ value }: { value: Questionnaire }) {
	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
			settled
		>
			<QuestionView definition={definition(value)} disabled drafts={{}} status="expired" />
		</SidecarCard>
	);
}

/** How a document card takes part in a deck; mirrors the inline card's own rules. */
export function inlineMemberState(
	value: Questionnaire,
	meta: Question.CardMeta | undefined,
	places: { [question: string]: number } | undefined,
	hasProseKey: boolean,
): MemberState {
	if (value.status === "expired") return "settled";
	if ((!meta || meta.status === "decided") && carriedByMarkers(value, places) && !hasProseKey) {
		return "hidden";
	}
	let shown = cardPresentation(value, meta, "deck");
	return shown === "open" ? "open" : shown === "hidden" ? "hidden" : "settled";
}

// Stable empty snapshots: useSyncExternalStore loops on a fresh value per call.
let NO_CARDS: ReadonlyMap<string, Question.CardMeta> = new Map();
let NO_ENTRIES: QuestionnaireEntry[] = [];
let noCards = () => NO_CARDS;
let noEntries = () => NO_ENTRIES;
let noop = () => () => {};

function useInlineDeck(id: string) {
	let options = useCellValue(widgets$);
	let store = options.questions;
	let entries = useSyncExternalStore(
		store?.subscribe ?? noop,
		store?.snapshot ?? noEntries,
		store?.snapshot ?? noEntries,
	);
	let cards = useSyncExternalStore(
		options.cardMeta?.subscribe ?? noop,
		options.cardMeta?.snapshot ?? noCards,
		options.cardMeta?.snapshot ?? noCards,
	);
	useRelations(store);
	let run = store?.runOf(id);
	if (!store || !run) return undefined;
	let values = new Map(entries.map(entry => [entry.id, entry.value]));
	let members = run.flatMap(member => {
		let value = values.get(member);
		if (!value) return [];
		let state = inlineMemberState(
			value,
			cards.get(member),
			store.counts(member),
			!!store.proseKey(member),
		);
		return [{ id: member, state, value }];
	});
	let layout = deckLayout(members);
	if (!layout || (layout.lead !== id && !layout.members.includes(id))) return undefined;
	return { layout, members: members.filter(member => layout.members.includes(member.id)) };
}

/** How many hidden decisions are being written up, told only to the first of them. */
function useWritingUp(id: string): number | undefined {
	let options = useCellValue(widgets$);
	let store = options.questions;
	let entries = useSyncExternalStore(
		store?.subscribe ?? noop,
		store?.snapshot ?? noEntries,
		store?.snapshot ?? noEntries,
	);
	let cards = useSyncExternalStore(
		options.cardMeta?.subscribe ?? noop,
		options.cardMeta?.snapshot ?? noCards,
		options.cardMeta?.snapshot ?? noCards,
	);
	useRelations(store);
	if (!store) return undefined;
	let writing = writingEntries(entries, cards, store, options.planner);
	return writing[0]?.id === id ? writing.length : undefined;
}

/** The hidden decisions whose prose is being written now, in document order. */
export function writingEntries(
	entries: readonly QuestionnaireEntry[],
	cards: ReadonlyMap<string, Question.CardMeta>,
	store: Pick<QuestionnaireStore, "plannerBusy" | "unwritten">,
	planner: boolean | undefined,
): QuestionnaireEntry[] {
	let plannerBusy = planner !== false && store.plannerBusy();
	return entries.filter(entry =>
		writingProse(entry.value, cards.get(entry.id), {
			unwritten: store.unwritten(entry.id),
			plannerBusy,
		})
	);
}

/**
 * Whether decisions are all a document holds, and the document draws none of them.
 *
 * Lexical shows no placeholder beside a decorator node, so a blank document that
 * keeps hidden decision projections needs the host to say it is blank.
 */
export function blankBehindDecisions(
	entries: readonly QuestionnaireEntry[],
	cards: ReadonlyMap<string, Question.CardMeta>,
	writing: readonly QuestionnaireEntry[],
): boolean {
	return entries.length > 0 && writing.length === 0
		&& entries.every(entry =>
			entry.value.status !== "expired"
			&& cardPresentation(entry.value, cards.get(entry.id), "inline") === "hidden"
		);
}

/** Where focus goes when a deck dissolves under the reader: the card that was on top. */
function focusCard(id: string) {
	let active = document.activeElement;
	if (active && active !== document.body) return;
	let card = document.querySelector<HTMLElement>(
		`[data-plan-questionnaire="${CSS.escape(id)}"] [data-plan-sidecar-questionnaire]:not([hidden])`,
	);
	if (!card) return;
	if (card.tabIndex < 0 && !card.hasAttribute("tabindex")) card.tabIndex = -1;
	card.focus({ preventScroll: true });
}

function InlineQuestionnaire({ value }: { value: Questionnaire }) {
	let options = useCellValue(widgets$);
	let phone = usePhone();
	let deck = useInlineDeck(value.id);
	// Phones answer in the Decisions pane, so each card is already a one-line chip; stacking
	// chips in a deck would hide all but one pointer behind a gesture.
	if (!deck || (phone && options.onShowDecision)) return <InlineCard value={value} />;
	if (deck.layout.lead !== value.id) return <div data-deck-follower="" hidden />;
	// Named by size, not "Decisions": a document can hold several decks beside the Decisions tab.
	return (
		<Deck
			label={`${deck.members.length} decisions`}
			onLeave={focusCard}
			items={deck.members.map(member => ({
				id: member.id,
				settled: member.state !== "open",
				label: member.value.questions[0]?.header ?? "Decision",
				card: <InlineCard deck value={member.value} />,
			}))}
		/>
	);
}

function InlineCard({ deck = false, value }: { deck?: boolean; value: Questionnaire }) {
	let options = useCellValue(widgets$);
	let meta = useCardMeta(options.cardMeta, value.id);
	let source = options.hasCardSource?.(value.id) ? options.onCardSource : undefined;
	let evidence = value.thread && (meta?.status === "open" || meta?.status === "reopened")
		? options.evidence?.(value.id)
		: null;
	// Re-render when anchors arrive: whether the card collapses depends on them.
	useRelations(options.questions);
	let phone = usePhone();
	let writing = useWritingUp(value.id);
	let places = options.questions?.counts(value.id);
	if (
		phone && options.onShowDecision && cardPresentation(value, meta, "inline") === "open"
	) {
		return <DecisionChip onShow={options.onShowDecision} value={value} />;
	}
	if (
		(!meta || meta.status === "decided") && carriedByMarkers(value, places)
		&& !options.questions?.proseKey(value.id)
	) {
		return <div data-plan-collapsed="" data-plan-sidecar-questionnaire={value.id} hidden />;
	}

	return (
		<QuestionnaireCard
			canEdit={options.canEdit}
			connected={options.connected}
			evidence={evidence}
			motion={options.questionMotion}
			motionImmediately={options.motionImmediately}
			onCardSource={source}
			self={options.self}
			meta={meta}
			onQuestionEnter={question => options.questions?.highlight(value.id, question)}
			onQuestionLeave={() => options.questions?.clear()}
			onQuestionSelect={question => options.questions?.reveal(value.id, question)}
			places={places}
			planner={options.planner !== false && !!options.questions?.plannerBusy()}
			presentation={deck ? "deck" : "inline"}
			relations={options.questions?.relations(value.id)}
			value={value}
			wire={options.wire}
			writing={deck ? undefined : writing}
		/>
	);
}

/**
 * An open decision in the document, on a phone.
 *
 * Phones answer decisions in the Decisions pane only; the prose keeps a
 * short pointer so the card is not shown, and answered, twice. The icon says
 * what it is, leaving the width to the question.
 */
function DecisionChip(
	{ onShow, value }: { onShow: (questionnaireId: string) => void; value: Questionnaire },
) {
	let question = value.questions.map(item => item.prompt).join(" · ");
	return (
		<button
			aria-label={`Decision: ${question}, answer in Decisions`}
			className="decision-chip"
			data-plan-sidecar-questionnaire={value.id}
			data-press="wide"
			onClick={() => onShow(value.id)}
			type="button"
		>
			<DecisionIcon aria-hidden="true" className="decision-chip-icon" size={14} />
			<span className="decision-chip-question">{question}</span>
			<ChevronIcon aria-hidden="true" className="decision-chip-chevron" size={14} />
		</button>
	);
}

export function renderQuestionnaire(node: QuestionnaireNode) {
	// React renders decorators after Lexical's read transaction has ended.
	return <InlineQuestionnaire value={node.getQuestionnaire()} />;
}
