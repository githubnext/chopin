/**
 * The questionnaire surface.
 *
 * Transport-free by design: it takes a definition, the current draft and a set
 * of callbacks. That is what lets the same view serve the chat card, where the
 * draft is a live CRDT, and a plan widget, where it is a resolved record.
 *
 * Everyone edits one shared draft, so controls reflect other people's choices
 * as they arrive rather than tracking local state.
 */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { CheckIcon, ChevronIcon, DecisionIcon, PlusIcon, WarningIcon } from "@chopin/icons";

import { INPUT_EXPIRY_MS, MAX_LABEL, MAX_SHARED_OPTIONS } from "../limits";
import { answered } from "../draft";
import { InlineCode } from "./inline-code";
import { plainInlineList, plainInlineText } from "./inline-segments";
import { projectSuggestion, reduceSuggestionEditState } from "./project-suggestion";
import { cardRelation, RelationNote } from "./relation-note";
import { ResolvedActions } from "./resolved-actions";
import type { VisibleSuggestion } from "./project-suggestion";
import type { Relation } from "../relation";

import type { ReactNode } from "react";
import type { Question } from "@chopin/protocol";
import type { Draft, Drafts } from "../draft";
import type { Answer, Definition, Item } from "../schema";

export type Collaborator = {
	/** Stable per connection, so one person on two devices shows twice. */
	client: string;
	handle: string;
	question?: string;
};

/** `option` is the id the server gave the new option, so the view can select it. */
export type AddOptionResult = { ok: true; option?: string } | { ok: false; message: string };

export type QuestionStepRenderProps = {
	children: ReactNode;
	question: string;
};

export type PreviousAnswer = { labels: string[]; by: string };

/** Unsaved answers on an open card, for a host that saves them from outside the card. */
export type PendingAnswers = {
	/** Questions with a selected answer that is not saved yet. */
	answered: number;
	/** Every question has an answer, so Save can submit this card. */
	complete: boolean;
	submitting: boolean;
	/** Why the last save or edit failed, shown on the card itself. */
	error?: string;
	save: () => void;
	/** Deselect the unsaved answers in the shared draft. */
	clear: () => void;
};

export type QuestionViewProps = {
	definition: Definition;
	drafts: Drafts;
	/** Absent once resolved: a decision is not re-opened, a new question is asked. */
	onChange?: (question: string, change: Partial<Draft>) => void;
	onSubmit?: (visibleSuggestion?: VisibleSuggestion) => void;
	suggested?: VisibleSuggestion;
	onDiscard?: () => void;
	onReopen?: () => void;
	previous?: PreviousAnswer | Record<string, PreviousAnswer>;
	refining?: boolean;
	showActions?: boolean;
	onCancel?: () => void;
	/**
	 * Append an option for everyone. Absent where the viewer may not write; the
	 * row is then shown disabled. Resolves once the server has made it durable.
	 */
	onAddOption?: (question: string, label: string) => Promise<AddOptionResult>;
	disabled?: boolean;
	submitting?: boolean;
	status?: "open" | Question.Status | "discarded";
	/** Shown instead of controls once the questionnaire has resolved. */
	answers?: Answer[];
	resolver?: string;
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
	/** Focus entered the open question (its id) or left it (undefined): presence for others. */
	onQuestionFocus?: (question: string | undefined) => void;
	/** Goes to the prose the decision lives in. */
	onQuestionSelect?: (question: string) => void;
	/**
	 * How many passages each decision lives in, by question.
	 *
	 * Absent where nothing links the two — the chat card, or a decision still
	 * waiting to be anchored. Without a destination the text stays inert prose
	 * rather than advertising a jump that would do nothing.
	 */
	places?: Record<string, number>;
	/** Whether each answered decision is linked, pending, deliberately empty or orphaned. */
	relations?: Record<string, Relation>;
	/** What a pending relationship is waiting on, when the host knows better than "Linking…". */
	pendingRelation?: string;
	/** A host's own word on an answered decision's prose, in place of the relation note. */
	relationNote?: ReactNode;
	collaborators?: Collaborator[];
	/**
	 * Replaces the `@handle` pills for people on the current question. The view
	 * cannot draw faces itself, so the host supplies them.
	 */
	renderPeople?: (people: Collaborator[]) => ReactNode;
	/** Validation or synchronisation problem, announced to assistive tech. */
	error?: string;
	/** Host-owned presentation class for an error entering the view. */
	errorClassName?: string;
	/** Host metadata, shown before an open question or below answered choices. */
	aside?: ReactNode;
	/** Controls in the trailing header, beside question-specific presence. */
	headerActions?: ReactNode;
	/** Lets a host retain bounded steps for presentation without owning question state. */
	renderStep?: (props: QuestionStepRenderProps) => ReactNode;
	/**
	 * The host shows Save outside the card, so the footer keeps only navigation
	 * and the quieter discard.
	 */
	deferSave?: boolean;
	/** Reports this card's unsaved answers; undefined when there is nothing to save. */
	onPending?: (pending: PendingAnswers | undefined) => void;
	/**
	 * Whether this person chose answers here, when the host keeps that beyond
	 * this view's lifetime. Without it the view remembers only while mounted.
	 */
	touched?: boolean;
	/** False when this person cleared their answers here. */
	onTouchedChange?: (touched: boolean) => void;
	/** This person chose an answer here; the host can keep what they chose. */
	onLocalChange?: (question: string, change: Partial<Draft>) => void;
};

export function currentQuestion(
	definition: Definition,
	active: string | undefined,
): Item {
	return definition.questions.find(question => question.id === active) ?? definition.questions[0]!;
}

/** Find a previous decision without applying one question's answer to another. */
export function previousFor(
	previous: QuestionViewProps["previous"],
	question: string,
): PreviousAnswer | undefined {
	if (!previous) return undefined;
	if (Array.isArray((previous as PreviousAnswer).labels)) return previous as PreviousAnswer;
	return (previous as Record<string, PreviousAnswer>)[question];
}

function Badges({ people }: { people: Collaborator[] }) {
	if (people.length === 0) return null;
	return (
		<span className="flex min-w-0 flex-wrap gap-1" aria-label="Editing this question">
			{people.map(person => (
				<span
					key={person.client}
					title={`@${person.handle} is editing`}
					className="max-w-28 truncate rounded-full bg-selected px-1.5 py-0.5 text-sm font-medium text-text-tertiary"
				>
					@{person.handle}
				</span>
			))}
		</span>
	);
}

function Presence(
	{ people, render }: { people: Collaborator[]; render?: (people: Collaborator[]) => ReactNode },
) {
	return render ? render(people) : <Badges people={people} />;
}

function DecisionHeading() {
	return (
		<header className="flex items-center gap-2 px-3 py-2.5 hairline-b">
			<CheckIcon aria-hidden="true" size={16} />
			<span className="text-sm font-medium text-text-primary">Decision</span>
		</header>
	);
}

function letter(index: number): string {
	return String.fromCharCode(65 + index);
}

/** A line-tall slot, so the tile centres on the label's first line, not the whole row. */
function Key({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden="true" className="question-key">
			<span>{children}</span>
		</span>
	);
}

function Choices(
	{ question, draft, disabled, name, onChange, suggestedOptionId }: {
		question: Item;
		draft: Draft | undefined;
		disabled: boolean;
		name: string;
		onChange?: (change: Partial<Draft>) => void;
		suggestedOptionId?: string;
	},
) {
	let custom = draft?.mode === "custom";

	return (
		<>
			{question.options.map((option, index) => {
				let selected = question.multiple
					? !!draft?.options[option.id]
					: draft?.choice === option.id;

				return (
					<label key={option.id} className="question-choice-row question-option">
						<input
							type={question.multiple ? "checkbox" : "radio"}
							name={question.multiple ? undefined : name}
							value={option.id}
							checked={!custom && selected}
							disabled={disabled}
							onChange={event => {
								// Choosing an option leaves custom mode; the two are
								// alternatives, not additions.
								onChange?.(
									question.multiple
										? {
											mode: "choices",
											options: { ...draft?.options, [option.id]: event.currentTarget.checked },
										}
										: { mode: "choices", choice: option.id },
								);
							}}
							className="question-input"
						/>
						<Key>{letter(index)}</Key>
						<span className="question-text">
							<span className="question-label">
								<InlineCode text={option.label} />
							</span>
							{!custom && selected && option.id === suggestedOptionId && (
								<span className="text-sm text-text-tertiary">{" from chat"}</span>
							)}
							{option.description && (
								<span className="question-desc">
									<InlineCode text={option.description} />
								</span>
							)}
						</span>
						<span aria-hidden="true" className="question-check">
							<CheckIcon />
						</span>
					</label>
				);
			})}
		</>
	);
}

/**
 * An open draft that was already in free-text mode before options became
 * shared. Shown as the selected row it was; choosing any option leaves it, and
 * nothing new can enter this mode.
 */
function LegacyCustom(
	{ question, draft, name }: { question: Item; draft: Draft; name: string },
) {
	return (
		<label className="question-choice-row question-option">
			<input
				type={question.multiple ? "checkbox" : "radio"}
				name={question.multiple ? undefined : name}
				checked
				onChange={() => {}}
				className="question-input"
			/>
			<Key>{letter(question.options.length)}</Key>
			<span className="question-text">
				<span className="question-label">{draft.custom.trim()}</span>
			</span>
			<span aria-hidden="true" className="question-check">
				<CheckIcon />
			</span>
		</label>
	);
}

/** The existing option a typed label would repeat, matched like the server does. */
export function duplicateOf(question: Item, label: string) {
	let key = label.toLowerCase();
	return question.options.find(option => option.label.trim().toLowerCase() === key);
}

/** Option labels are one line in the document, so a pasted line break becomes a space. */
export function optionText(typed: string): string {
	return typed.replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * The draft change that chooses a just-added option, as if its row had been
 * clicked. Undefined when that would replace a collaborator's single choice in
 * the shared draft: adding is for everyone, but only the adder's own pick moves.
 * `mine` is the last option this person chose for the question, if any; the
 * answer is theirs only while the shared draft still holds it.
 */
export function chooseAdded(
	question: Item,
	draft: Draft | undefined,
	option: string,
	mine: string | null | undefined,
): Partial<Draft> | undefined {
	if (question.multiple) {
		return { mode: "choices", options: { ...draft?.options, [option]: true } };
	}
	let own = !!mine && draft?.mode === "choices" && draft.choice === mine;
	if (!own && answered(question, draft)) return undefined;
	return { mode: "choices", choice: option };
}

/**
 * The last row: a prompt to add an option, which becomes the field for it.
 *
 * The leading tile turns into the confirm button once there is text. Enter or
 * the tile adds the option for everyone; once the server has made it durable
 * the host selects it for this person. Escape closes the field. While
 * confirmation is pending the field stays focusable so Escape still works; a
 * rejection keeps the text intact.
 */
function AddOption(
	{ question, disabled, onAdd, onAdded, onFailed, onEdit, onCancelEdit, onCommitEdit }: {
		question: Item;
		disabled: boolean;
		onAdd?: (label: string) => Promise<AddOptionResult>;
		/** The server added the option; `focus` when this field still held focus. */
		onAdded: (option: string, label: string, focus: boolean) => void;
		onFailed: (message: string | undefined) => void;
		onEdit?: () => void;
		onCancelEdit?: () => void;
		onCommitEdit?: () => void;
	},
) {
	let [text, setText] = useState<string | null>(null);
	let [pending, setPending] = useState<string | null>(null);
	let hintId = useId();
	let group = useRef<HTMLDivElement>(null);
	let input = useRef<HTMLTextAreaElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focus = useRef<"field" | "trigger">(undefined);
	let edit = useRef(0);
	let label = text?.trim() ?? "";
	let duplicate = label ? duplicateOf(question, label) : undefined;
	let ready = !!label && !duplicate && !disabled;

	useEffect(() => {
		let target = focus.current;
		focus.current = undefined;
		if (target === "field") input.current?.focus();
		else if (target === "trigger") trigger.current?.focus();
	});

	// Browsers without `field-sizing` would otherwise scroll a long option inside one line.
	useLayoutEffect(() => {
		let field = input.current;
		if (!field || CSS.supports("field-sizing", "content")) return;
		field.style.blockSize = "auto";
		field.style.blockSize = `${field.scrollHeight}px`;
	}, [text]);

	useEffect(() => {
		let viewport = window.visualViewport;
		if (!viewport) return;
		let height = viewport.height;
		let reveal = () => {
			let previous = height;
			height = viewport.height;
			let control = input.current;
			if (height >= previous || document.activeElement !== control || !control) return;
			let bounds = control.getBoundingClientRect();
			let top = viewport.offsetTop;
			// The field's scroll margin is the room it wants below it, such as its hint.
			let room = parseFloat(getComputedStyle(control).scrollMarginBlockEnd) || 0;
			let bottom = top + viewport.height - room;
			if (bounds.top >= top && bounds.bottom <= bottom) return;
			requestAnimationFrame(() => control.scrollIntoView({ block: "nearest" }));
		};

		viewport.addEventListener("resize", reveal);
		return () => viewport.removeEventListener("resize", reveal);
	}, []);

	let add = async () => {
		if (!label || !onAdd || pending !== null || duplicateOf(question, label)) return;
		let submittedEdit = edit.current;
		setPending(label);
		onFailed(undefined);
		let result: AddOptionResult;
		try {
			result = await onAdd(label);
		} catch {
			result = { ok: false, message: "Could not add this option." };
		}
		setPending(null);
		if (edit.current !== submittedEdit) return;
		let field = group.current;
		let ownsFocus = field
			? field.contains(document.activeElement)
			: document.activeElement === document.body;
		if (result.ok) {
			onCommitEdit?.();
			setText(null);
			if (result.option) onAdded(result.option, label, ownsFocus);
			else if (ownsFocus) focus.current = "trigger";
		} else {
			onFailed(result.message);
			if (ownsFocus) focus.current = "field";
		}
	};

	if (text === null) {
		return (
			<button
				type="button"
				className="question-choice-row question-option question-add"
				data-press="wide"
				disabled={disabled || !onAdd}
				onClick={() => {
					edit.current++;
					focus.current = "field";
					setText("");
				}}
				ref={trigger}
			>
				<Key>
					<PlusIcon />
				</Key>
				<span className="question-text">Add an option</span>
			</button>
		);
	}

	return (
		<div className="question-adding-group" ref={group}>
			<div
				aria-busy={pending !== null || undefined}
				className="question-choice-row question-option question-adding"
			>
				<span className="question-key">
					<button
						aria-disabled={pending !== null || undefined}
						aria-label="Add option"
						className="question-add-confirm"
						data-ready={ready || pending !== null ? "" : undefined}
						disabled={!ready && pending === null}
						onClick={() => void add()}
						type="button"
					>
						<PlusIcon aria-hidden="true" />
						<CheckIcon aria-hidden="true" />
					</button>
				</span>
				<textarea
					aria-disabled={pending !== null || undefined}
					aria-describedby={hintId}
					aria-invalid={duplicate ? true : undefined}
					aria-label="New option"
					autoComplete="off"
					className="question-field"
					disabled={disabled}
					enterKeyHint="done"
					maxLength={MAX_LABEL}
					onBlur={event => {
						// Only an empty field collapses by itself. Typed text is kept, because
						// adding an option is visible to everyone and should be deliberate.
						if (group.current?.contains(event.relatedTarget)) return;
						if (!text.trim() && pending === null) {
							edit.current++;
							onCancelEdit?.();
							setText(null);
						}
					}}
					onChange={event => {
						onEdit?.();
						setText(optionText(event.currentTarget.value));
						onFailed(undefined);
					}}
					onKeyDown={event => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							edit.current++;
							onCancelEdit?.();
							setText(null);
							onFailed(undefined);
							focus.current = "trigger";
						} else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void add();
						}
					}}
					placeholder="Add an option"
					readOnly={pending !== null}
					ref={input}
					rows={1}
					value={text}
				/>
				{pending !== null && <span className="sr-only" role="status">Adding option</span>}
			</div>
			<p
				className="question-add-hint"
				id={hintId}
				role="status"
			>
				{duplicate ? `Already an option: ${duplicate.label}` : ""}
			</p>
		</div>
	);
}

const LINK = "flex w-full cursor-pointer items-start justify-between gap-2 rounded-sm text-left";

/**
 * Something that may refer to somewhere else.
 *
 * Rendered as a button only when there is somewhere to go, so a real element
 * carries the affordance and the keyboard handling rather than text pretending
 * to be one. Unlinked, it takes no tab stop and offers no focus ring it could
 * never show.
 *
 * On resolved cards, only the heading is linked. Static answer rows stay
 * outside the button, leaving one destination per question.
 *
 * `label` is the plain-text reading of the children. It is composed into the
 * accessible name rather than replacing it: the decision is what the button is
 * for, and a name saying only where it goes would take it away from anybody who
 * cannot see it.
 */
function Related(
	{ id, count, label, className, children, inline, onEnter, onLeave, onSelect }: {
		id: string | undefined;
		count: number;
		label: string;
		className: string;
		children: ReactNode;
		/** Sits inside a heading, so the unlinked form must be phrasing content. */
		inline?: boolean;
		onEnter?: QuestionViewProps["onQuestionEnter"];
		onLeave?: QuestionViewProps["onQuestionLeave"];
		onSelect?: QuestionViewProps["onQuestionSelect"];
	},
) {
	if (!id || count === 0) {
		return inline
			? <span className={className}>{children}</span>
			: <div className={className}>{children}</div>;
	}

	return (
		<button
			type="button"
			data-ace-question-id={id}
			data-press="wide"
			aria-label={count > 1
				? `${label} — show in document, ${count} places`
				: `${label} — show in document`}
			onClick={() => onSelect?.(id)}
			onMouseEnter={() => onEnter?.(id)}
			onMouseLeave={event => event.currentTarget !== document.activeElement && onLeave?.(id)}
			onFocus={() => onEnter?.(id)}
			onBlur={event => !event.currentTarget.matches(":hover") && onLeave?.(id)}
			className={`${className} ${LINK}`}
		>
			<span className="min-w-0 flex-1">{children}</span>
			{count > 1 && (
				<span aria-hidden="true" className="shrink-0 text-sm text-text-tertiary tabular-nums">
					{count}
				</span>
			)}
		</button>
	);
}

function Resolved(
	{
		answers,
		aside,
		definition,
		resolver,
		places,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
	}: {
		answers: Answer[];
		aside?: ReactNode;
		definition: Definition;
		resolver?: string;
		places?: QuestionViewProps["places"];
		onQuestionEnter?: QuestionViewProps["onQuestionEnter"];
		onQuestionLeave?: QuestionViewProps["onQuestionLeave"];
		onQuestionSelect?: QuestionViewProps["onQuestionSelect"];
	},
) {
	return (
		<div>
			<div className="space-y-4">
				{answers.map((answer, index) => {
					let question = definition.questions[index];
					let id = question?.id;
					let options = question?.options ?? [];
					let chosenIds = answer.optionIds === undefined ? undefined : new Set(answer.optionIds);
					let chosenLabels = new Set(answer.choices ?? []);
					let selected = options.filter(option =>
						chosenIds ? chosenIds.has(option.id) : chosenLabels.has(option.label)
					);
					let matchedLabels = new Set(selected.map(option => option.label));
					let unmatched = answer.custom
						? [answer.custom]
						: (answer.choices ?? []).filter(label => !matchedLabels.has(label));
					return (
						<section className="question-resolved-section" key={id ?? index}>
							<header className="question-head">
								<span className="question-mark" title="Decision">
									<DecisionIcon />
								</span>
								<div className="question-head-text">
									<h4 className="question-title">
										<Related
											id={id}
											count={(id ? places?.[id] : undefined) ?? 0}
											label={answer.question}
											className="question-title-link"
											inline
											onEnter={onQuestionEnter}
											onLeave={onQuestionLeave}
											onSelect={onQuestionSelect}
										>
											<InlineCode text={answer.question} />
										</Related>
									</h4>
									{question?.description && (
										<p className="question-hint">
											<InlineCode text={question.description} />
										</p>
									)}
								</div>
							</header>
							<div className="question-options">
								{options.map((option, optionIndex) => {
									let isSelected = selected.includes(option);
									return (
										<div
											className="question-choice-row question-option"
											data-selected={isSelected ? "" : undefined}
											key={option.id}
										>
											<Key>{letter(optionIndex)}</Key>
											<span className="question-text">
												<span className="question-label">
													{isSelected && <span className="sr-only">{"Selected: "}</span>}
													<InlineCode text={option.label} />
												</span>
												{option.description && (
													<span className="question-desc">
														<InlineCode text={option.description} />
													</span>
												)}
											</span>
											<span aria-hidden="true" className="question-check">
												<CheckIcon />
											</span>
										</div>
									);
								})}
								{unmatched.map((label, unmatchedIndex) => (
									<div
										className="question-choice-row question-option"
										data-selected=""
										key={`${label}-${unmatchedIndex}`}
									>
										<Key>{letter(options.length + unmatchedIndex)}</Key>
										<span className="question-text">
											<span className="question-label">
												<span className="sr-only">{"Selected: "}</span>
												<InlineCode text={label} />
											</span>
										</span>
										<span aria-hidden="true" className="question-check">
											<CheckIcon />
										</span>
									</div>
								))}
							</div>
						</section>
					);
				})}
			</div>
			{aside
				? <div className="question-resolved-meta">{aside}</div>
				: resolver && <p className="question-resolved-meta">Answered by @{resolver}</p>}
		</div>
	);
}

/** A question nobody answered. There is nothing to show but who ended it. */
function Cancelled({ resolver }: { resolver?: string }) {
	return (
		<div className="px-3 py-2.5">
			<p className="m-0 text-sm text-text-secondary">
				{resolver && resolver !== "system"
					? `Cancelled by @${resolver}`
					: "Cancelled — the question was never answered."}
			</p>
		</div>
	);
}

function Discarded({ definition, resolver }: { definition: Definition; resolver?: string }) {
	let questions = definition.questions.map(question => question.question).join(", ");
	let discarded = resolver && resolver !== "system" ? `Discarded by @${resolver}` : "Discarded";
	return (
		<div className="px-3 py-2.5">
			<p className="m-0 text-sm text-text-secondary">
				{discarded}
				{questions ? ` — ${questions}` : ""}
			</p>
		</div>
	);
}

function Callout(
	{ feedback, message, title }: { feedback?: string; message: string; title: string },
) {
	return (
		<div
			className={`plan-research-callout question-callout${feedback ? ` ${feedback}` : ""}`}
			data-motion-feedback={feedback ? "alert" : undefined}
			role="alert"
		>
			<span aria-hidden="true" className="plan-research-badge">
				<WarningIcon />
			</span>
			<p>
				<strong>{title}</strong>
				{message}
			</p>
		</div>
	);
}

const EXPIRED_NOTE = `Nobody answered within ${
	INPUT_EXPIRY_MS / 60_000
} minutes. The Planner will use its best judgement for this decision.`;

/**
 * Host input whose time ran out. Unlike a cancelled card it stays in the
 * document, so it keeps what was asked beside the note saying nobody answered.
 */
function Expired({ definition }: { definition: Definition }) {
	return (
		<div className="space-y-2 px-3 py-2.5">
			{definition.questions.map(question => (
				<p key={question.id} className="m-0 text-sm text-text-secondary">
					<InlineCode text={question.question} />
				</p>
			))}
			<p className="m-0 text-sm text-text-primary">{EXPIRED_NOTE}</p>
		</div>
	);
}

export function QuestionView(props: QuestionViewProps) {
	let {
		definition,
		drafts,
		onChange,
		onSubmit,
		onCancel,
		onDiscard,
		onReopen,
		suggested,
		previous: priorAnswers,
		refining,
		showActions = false,
		onAddOption,
		disabled = false,
		submitting = false,
		status = "open",
		answers,
		resolver,
		collaborators = [],
		renderPeople,
		error,
		errorClassName,
		aside,
		headerActions,
		places,
		relations,
		pendingRelation,
		relationNote: hostNote,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionFocus,
		onQuestionSelect,
		renderStep,
		deferSave = false,
		onPending,
		touched: hostTouched,
		onTouchedChange,
		onLocalChange,
	} = props;

	let [suggestionEdits, dispatchSuggestionEdit] = useReducer(reduceSuggestionEditState, {
		answer: false,
		composer: false,
		suggestionPresent: false,
		suggestionGeneration: 0,
	});
	useEffect(() => {
		// A missing suggestion starts a new lifecycle; revision changes stay in the same one.
		dispatchSuggestionEdit({ type: suggested ? "suggestion-visible" : "suggestion-cleared" });
	}, [suggested]);
	let markHumanEdit = () => {
		if (suggested) dispatchSuggestionEdit({ type: "answer-edited" });
	};
	// Which cards this person chose answers on, so a host's pane-wide Save
	// never acts on a draft only a collaborator touched.
	let [ownTouched, setOwnTouched] = useState(false);
	let touched = hostTouched ?? ownTouched;
	let setTouched = (value: boolean) => {
		setOwnTouched(value);
		if (!value) onTouchedChange?.(false);
	};

	let markComposerEdit = () => {
		dispatchSuggestionEdit({ type: "composer-edited" });
	};
	let cancelComposerEdit = () => dispatchSuggestionEdit({ type: "composer-cancelled" });
	let commitComposerEdit = () => dispatchSuggestionEdit({ type: "composer-committed" });

	let base = useId();
	let single = definition.questions.length === 1;
	let [selected, setActive] = useState(() => definition.questions[0]?.id);
	let current = currentQuestion(definition, selected);
	let active = current.id;
	let panelId = `${base}-panel-${active}`;
	if (active !== selected) setActive(active);
	// Discarding cannot be undone and the agent is waiting, so it takes a
	// second, deliberate click rather than a modal nobody reads.
	let [confirming, setConfirming] = useState(false);
	// Presence follows the current question and ends when it changes or the card goes.
	let focusing = useRef(onQuestionFocus);
	focusing.current = onQuestionFocus;
	useEffect(() => () => focusing.current?.(undefined), [active]);
	let [addError, setAddError] = useState<string>();
	let [announcement, setAnnouncement] = useState("");
	let options = useRef<HTMLFieldSetElement>(null);
	let focusOption = useRef<string>(undefined);
	// The last single choice this person made per question, to tell their answer from a collaborator's.
	let picks = useRef<Record<string, string | null>>({});
	// The new option's row renders once its definition arrives, maybe a render later.
	useEffect(() => {
		let id = focusOption.current;
		if (!id) return;
		let row = [...options.current?.querySelectorAll<HTMLInputElement>(".question-input") ?? []]
			.find(input => input.value === id);
		if (!row) return;
		focusOption.current = undefined;
		row.focus();
	});
	let previous = useRef<HTMLButtonElement>(null);
	let next = useRef<HTMLButtonElement>(null);
	let primary = useRef<HTMLButtonElement>(null);
	let refocus = useRef<"previous" | "next" | "primary">(undefined);

	// At either end the activated caret disables. Keep focus inside the stepper
	// so the new question is reached instead of dropping to the body.
	useEffect(() => {
		let target = refocus.current;
		refocus.current = undefined;
		if (target === "previous") previous.current?.focus();
		else if (target === "next") next.current?.focus();
		else if (target === "primary") primary.current?.focus();
	}, [active]);

	let projection = single
		? projectSuggestion(
			current,
			drafts[current.id],
			suggested,
			suggestionEdits.answer || suggestionEdits.composer,
		)
		: { draft: drafts[current.id] };

	// Only a draft this person chose counts. A visible suggestion is not an
	// answer until someone accepts it on the card, and a collaborator's choice
	// on a card this person never touched is theirs to save.
	let answeredCount =
		definition.questions.filter(question => answered(question, drafts[question.id])).length;
	let complete = answeredCount === definition.questions.length;
	let pendingEnabled = status === "open" && !disabled && !!onSubmit && !!onChange && touched;
	let mounted = useRef(true);
	let latest = useRef({ onChange, onSubmit, markHumanEdit, drafts, definition, active, status });
	latest.current = { onChange, onSubmit, markHumanEdit, drafts, definition, active, status };
	let reporting = useRef(onPending);
	reporting.current = onPending;
	useEffect(() => {
		let report = reporting.current;
		if (!report) return;
		if (!pendingEnabled || (answeredCount === 0 && !submitting)) {
			report(undefined);
			return;
		}
		report({
			answered: answeredCount,
			complete,
			submitting,
			error,
			save: () => latest.current.onSubmit?.(),
			clear: () => {
				let { definition, drafts, markHumanEdit, onChange } = latest.current;
				markHumanEdit();
				setTouched(false);
				for (let question of definition.questions) {
					let draft = drafts[question.id];
					if (!draft || !answered(question, draft)) continue;
					onChange?.(
						question.id,
						question.multiple
							? {
								mode: "choices",
								options: Object.fromEntries(
									Object.keys(draft.options).map(option => [option, false]),
								),
							}
							: { mode: "choices", choice: null },
					);
				}
			},
		});
	}, [answeredCount, complete, error, pendingEnabled, submitting]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			reporting.current?.(undefined);
		};
	}, []);

	if (status === "discarded") {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				<Discarded definition={definition} resolver={resolver} />
			</div>
		);
	}

	// A cancelled or expired questionnaire has no answers, so it must be matched
	// on status alone — falling through would offer an editable form for a dead
	// question.
	if (status === "cancelled" || status === "expired") {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				{status === "expired"
					? <Expired definition={definition} />
					: <Cancelled resolver={resolver} />}
			</div>
		);
	}

	if (status !== "open") {
		let related = answers
			? cardRelation(relations, definition.questions.map(question => question.id))
			: undefined;
		let relationNote = hostNote ?? (related && (
			<RelationNote
				count={places?.[related.question]}
				onEnter={onQuestionEnter}
				onLeave={onQuestionLeave}
				onSelect={onQuestionSelect}
				pending={pendingRelation}
				question={related.question}
				relation={related.relation}
			/>
		));
		return (
			<div className="question-card">
				{answers
					? (
						<Resolved
							answers={answers}
							aside={aside}
							definition={definition}
							resolver={resolver}
							// One control per destination: a linked note takes over the jump.
							places={related?.relation === "linked" ? undefined : places}
							onQuestionEnter={onQuestionEnter}
							onQuestionLeave={onQuestionLeave}
							onQuestionSelect={onQuestionSelect}
						/>
					)
					: (
						<div>
							<p className="m-0 px-2 text-sm text-text-secondary">Saved decision</p>
							{aside && <div className="question-resolved-meta">{aside}</div>}
						</div>
					)}
				{error && <Callout feedback={errorClassName} title="Couldn’t save" message={error} />}
				<ResolvedActions
					className="question-actions"
					disabled={disabled}
					onDiscard={onDiscard}
					onReopen={onReopen}
					submitting={submitting}
					note={relationNote}
				/>
			</div>
		);
	}

	let multiple = !single;
	let index = definition.questions.findIndex(question => question.id === active);
	let total = definition.questions.length;
	let last = index === total - 1;
	// Nothing chosen, nothing to save or move on with. Read-only hosts have no
	// drafts to fill, so they keep free navigation.
	let ready = answered(current, projection.draft);
	// Accepting a suggestion stays a deliberate choice on its own card.
	let suggestion = projection.suggestion;
	let acceptSuggestion = () => onSubmit?.(suggestion);
	let saveHere = () => onSubmit?.();
	let discard = onDiscard ?? onCancel;
	let previousAnswer = previousFor(priorAnswers, current.id);
	let step = (offset: number, from?: "primary") => {
		let question = definition.questions[index + offset];
		if (!question) return;
		setActive(question.id);
		setAddError(undefined);
		setAnnouncement("");
		let arrived = index + offset;
		if (from) refocus.current = "primary";
		else if (arrived === 0) refocus.current = "next";
		else if (arrived === total - 1) refocus.current = "previous";
	};
	let titleId = `${base}-title-${active}`;
	let choose = (question: string, change: Partial<Draft>) => {
		if (change.choice !== undefined) picks.current[question] = change.choice;
		markHumanEdit();
		setTouched(true);
		onLocalChange?.(question, change);
		onChange?.(question, change);
	};
	let added = (question: string, option: string, label: string, focus: boolean) => {
		// The field unmounts at capacity; the question host owns whether this add is still current.
		if (
			!mounted.current || latest.current.active !== question || latest.current.status !== "open"
		) {
			return;
		}
		let item = latest.current.definition.questions.find(each => each.id === question);
		if (!item) return;
		let change = chooseAdded(
			item,
			latest.current.drafts[question],
			option,
			picks.current[question],
		);
		if (change) choose(question, change);
		if (focus) focusOption.current = option;
		setAnnouncement(change ? `Added and selected ${label}` : `Added ${label}`);
	};

	return (
		<div aria-busy={submitting} className="question-card" data-saving={submitting ? "" : undefined}>
			{aside}

			{(() => {
				let panel = (
					<section
						aria-labelledby={titleId}
						data-ace-question-id={current.id}
						id={panelId}
						onMouseEnter={() => onQuestionEnter?.(current.id)}
						onMouseLeave={event =>
							!event.currentTarget.contains(document.activeElement)
							&& onQuestionLeave?.(current.id)}
						onFocusCapture={() => {
							onQuestionEnter?.(current.id);
							onQuestionFocus?.(current.id);
						}}
						onBlurCapture={event => {
							if (event.currentTarget.contains(event.relatedTarget)) {
								return;
							}
							onQuestionFocus?.(undefined);
							if (!event.currentTarget.matches(":hover")) {
								onQuestionLeave?.(current.id);
							}
						}}
					>
						<header className="question-head" data-refining={refining ? "true" : undefined}>
							<span className="question-mark" title="Decision">
								<DecisionIcon />
							</span>
							<div className="question-head-text">
								<h4 className="question-title" id={titleId}>
									<Related
										id={current.id}
										count={places?.[current.id] ?? 0}
										label={plainInlineText(current.question)}
										className="question-title-link"
										inline
										onSelect={onQuestionSelect}
									>
										<InlineCode text={current.question} />
									</Related>
								</h4>
								{current.description && (
									<p className="question-hint">
										<InlineCode text={current.description} />
									</p>
								)}
								{current.multiple && <p className="question-hint">Choose any</p>}
								{previousAnswer && (
									<p className="question-hint">
										Previously chosen by @{previousAnswer.by}:{" "}
										{plainInlineList(previousAnswer.labels)}
									</p>
								)}
								{refining && <p className="question-hint" role="status">Chopin is refining…</p>}
							</div>
							<span className="flex shrink-0 items-center gap-2">
								<Presence
									people={collaborators.filter(person =>
										person.question === current.id
									)}
									render={renderPeople}
								/>
								{headerActions}
							</span>
						</header>

						<fieldset disabled={disabled} className="question-options" ref={options}>
							<legend className="sr-only">{current.header}</legend>
							<Choices
								question={current}
								draft={projection.draft}
								disabled={disabled}
								name={`${base}-${current.id}`}
								onChange={change =>
									choose(current.id, change)}
								suggestedOptionId={projection.suggestion?.optionId}
							/>
							{drafts[current.id]?.mode === "custom" && drafts[current.id]!.custom.trim() && (
								<LegacyCustom
									question={current}
									draft={drafts[current.id]!}
									name={`${base}-${current.id}`}
								/>
							)}
							{onAddOption && current.options.length < MAX_SHARED_OPTIONS && (
								<AddOption
									key={current.id}
									question={current}
									disabled={disabled}
									onAdd={label => onAddOption(current.id, label)}
									onAdded={(option, label, focus) => added(current.id, option, label, focus)}
									onFailed={setAddError}
									onEdit={markComposerEdit}
									onCancelEdit={cancelComposerEdit}
									onCommitEdit={commitComposerEdit}
								/>
							)}
						</fieldset>
					</section>
				);

				return renderStep ? renderStep({ children: panel, question: current.id }) : panel;
			})()}

			<span aria-live="polite" className="sr-only">{announcement}</span>
			{addError && <Callout title="Couldn’t add option" message={addError} />}
			{error && (
				<Callout
					feedback={errorClassName}
					message={error}
					title="Couldn’t save"
				/>
			)}

			{(onSubmit || discard || multiple || showActions) && (
				<footer
					className="question-actions"
					data-confirm={discard && confirming ? "" : undefined}
				>
					{discard && confirming
						? (
							<>
								<span className="question-confirm">
									Discard this decision?
								</span>
								<button
									type="button"
									onClick={() => setConfirming(false)}
									disabled={submitting}
									className="btn btn-sm btn-outline"
								>
									Keep it
								</button>
								<button
									type="button"
									onClick={discard}
									disabled={disabled || submitting}
									className="btn btn-sm btn-destructive"
								>
									{submitting ? "Discarding…" : "Discard"}
								</button>
							</>
						)
						: (
							<>
								{multiple && (
									<div role="group" aria-label="Questions" className="question-stepper">
										<button
											type="button"
											aria-label="Previous question"
											className="btn btn-icon btn-ghost question-caret"
											data-flip=""
											disabled={index === 0}
											onClick={() => step(-1)}
											ref={previous}
										>
											<ChevronIcon size={16} />
										</button>
										<span className="question-count" aria-live="polite">
											<strong>{current.header}</strong>
											{index + 1}/{total}
										</span>
										<button
											type="button"
											aria-label="Next question"
											className="btn btn-icon btn-ghost question-caret"
											disabled={last}
											onClick={() => step(1)}
											ref={next}
										>
											<ChevronIcon size={16} />
										</button>
									</div>
								)}
								{(discard || showActions) && (
									<button
										type="button"
										onClick={() => setConfirming(true)}
										disabled={disabled || submitting}
										className={deferSave
											? "btn btn-sm btn-ghost question-discard-quiet"
											: "btn btn-sm btn-outline"}
									>
										{deferSave ? "Discard decision" : "Discard"}
									</button>
								)}
								{multiple && !last && (
									<button
										type="button"
										onClick={() => step(1, "primary")}
										disabled={!!onChange && !ready}
										className="btn btn-sm btn-primary"
										ref={primary}
									>
										Next
									</button>
								)}
								{(onSubmit || showActions) && (!multiple || last) && !deferSave && (
									<button
										type="button"
										onClick={() => onSubmit?.(projection.suggestion)}
										disabled={disabled || submitting || !onSubmit || !ready}
										className="btn btn-sm btn-primary"
										ref={primary}
									>
										{submitting ? "Saving…" : error ? "Try again" : "Save"}
									</button>
								)}
								{deferSave && onSubmit && !suggestion && !touched && answeredCount > 0
									&& (!multiple || last) && (
										// A selection the bar is not counting still needs a way to be saved.
										<button
											type="button"
											onClick={saveHere}
											disabled={disabled || submitting || !ready}
											className="btn btn-sm btn-primary"
										>
											{submitting ? "Saving…" : error ? "Try again" : "Save"}
										</button>
									)}
								{deferSave && onSubmit && suggestion && (
									<button
										type="button"
										onClick={acceptSuggestion}
										disabled={disabled || submitting}
										className="btn btn-sm btn-primary"
									>
										{submitting ? "Saving…" : "Accept suggestion"}
									</button>
								)}
							</>
						)}
				</footer>
			)}
		</div>
	);
}
