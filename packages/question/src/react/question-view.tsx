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

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { CheckIcon, ChevronIcon, DecisionIcon, PlusIcon, WarningIcon } from "@chopin/icons";

import { MAX_LABEL, MAX_SHARED_OPTIONS } from "../limits";
import { answered } from "../draft";
import { projectSuggestion, reduceSuggestionEditState } from "./project-suggestion";
import { ResolvedActions } from "./resolved-actions";
import type { VisibleSuggestion } from "./project-suggestion";

import type { ReactNode } from "react";
import type { Draft, Drafts } from "../draft";
import type { Answer, Definition, Item } from "../schema";

export type Collaborator = {
	/** Stable per connection, so one person on two devices shows twice. */
	client: string;
	handle: string;
	question?: string;
};

export type AddOptionResult = { ok: true } | { ok: false; message: string };

export type QuestionStepRenderProps = {
	children: ReactNode;
	question: string;
};

export type PreviousAnswer = { labels: string[]; by: string };

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
	status?: "open" | "answered" | "cancelled" | "discarded";
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
	/** Rendered beside the heading; hosts use it for counts and provenance. */
	aside?: ReactNode;
	/** Lets a host retain bounded steps for presentation without owning question state. */
	renderStep?: (props: QuestionStepRenderProps) => ReactNode;
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
			<CheckIcon aria-hidden="true" size={14} />
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
							<span className="question-label">{option.label}</span>
							{!custom && selected && option.id === suggestedOptionId && (
								<span className="text-sm text-text-tertiary">{" from chat"}</span>
							)}
							{option.description && <span className="question-desc">{option.description}</span>}
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

/**
 * The last row: a prompt to add an option, which becomes the field for it.
 *
 * Enter adds it for everyone, Escape cancels. The new row is shown straight
 * away, dimmed, until the server confirms it; a rejection reopens the field
 * with the text intact.
 */
function AddOption(
	{ question, offset, disabled, onAdd, onFailed, onEdit, onCancelEdit, onCommitEdit }: {
		question: Item;
		/** Rows already shown below the options, such as a legacy custom answer. */
		offset: number;
		disabled: boolean;
		onAdd?: (label: string) => Promise<AddOptionResult>;
		onFailed: (message: string | undefined) => void;
		onEdit?: () => void;
		onCancelEdit?: () => void;
		onCommitEdit?: () => void;
	},
) {
	let [text, setText] = useState<string | null>(null);
	let [pending, setPending] = useState<string | null>(null);
	let input = useRef<HTMLInputElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focus = useRef<"field" | "trigger">(undefined);
	let letterIndex = question.options.length + offset;

	useEffect(() => {
		let target = focus.current;
		focus.current = undefined;
		if (target === "field") input.current?.focus();
		else if (target === "trigger") trigger.current?.focus();
	});

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
			let bottom = top + viewport.height;
			if (bounds.top >= top && bounds.bottom <= bottom) return;
			requestAnimationFrame(() => control.scrollIntoView({ block: "nearest" }));
		};

		viewport.addEventListener("resize", reveal);
		return () => viewport.removeEventListener("resize", reveal);
	}, []);

	let add = async () => {
		let label = text?.trim();
		if (!label || !onAdd || pending !== null) return;
		setPending(label);
		onFailed(undefined);
		let result: AddOptionResult;
		try {
			result = await onAdd(label);
		} catch {
			result = { ok: false, message: "Could not add this option." };
		}
		setPending(null);
		if (result.ok) {
			onCommitEdit?.();
			setText(null);
			focus.current = "trigger";
		} else {
			onFailed(result.message);
			focus.current = "field";
		}
	};

	// Until the server confirms, the new row stands where the field was. If the
	// broadcast beat the acknowledgement, the real row is already listed above.
	if (pending !== null) {
		let known = question.options.some(option =>
			option.label.trim().toLowerCase() === pending.toLowerCase()
		);
		if (known) return null;
		return (
			<div aria-busy="true" className="question-choice-row question-option question-pending">
				<Key>{letter(letterIndex)}</Key>
				<span className="question-text">
					<span className="question-label">{pending}</span>
				</span>
				<span className="sr-only" role="status">Adding option</span>
			</div>
		);
	}

	if (text === null) {
		return (
			<button
				type="button"
				className="question-choice-row question-option question-add"
				data-press="wide"
				disabled={disabled || !onAdd}
				onClick={() => {
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
		<div className="question-choice-row question-option question-adding">
			<Key>{letter(letterIndex)}</Key>
			<input
				aria-label="New option"
				autoComplete="off"
				className="question-field"
				disabled={disabled}
				maxLength={MAX_LABEL}
				onBlur={() => {
					// Only an empty field collapses by itself. Typed text is kept, because
					// adding an option is visible to everyone and should be deliberate.
					if (!text.trim()) {
						onCancelEdit?.();
						setText(null);
					}
				}}
				onChange={event => {
					onEdit?.();
					setText(event.currentTarget.value);
					onFailed(undefined);
				}}
				onKeyDown={event => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
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
				ref={input}
				value={text}
			/>
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
 * Wraps whatever it is given rather than being a paragraph itself, because on a
 * resolved card what points into the plan is the question *and* its answer
 * together. Those used to be two adjacent, identically-labelled buttons — one
 * for what the question was about, one for what the answer produced — which the
 * agent anchored to overlapping prose, so the two led to the same block.
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
				? `${label} — show in plan, ${count} places`
				: `${label} — show in plan`}
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
		definition,
		resolver,
		places,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
	}: {
		answers: Answer[];
		definition: Definition;
		resolver?: string;
		places?: QuestionViewProps["places"];
		onQuestionEnter?: QuestionViewProps["onQuestionEnter"];
		onQuestionLeave?: QuestionViewProps["onQuestionLeave"];
		onQuestionSelect?: QuestionViewProps["onQuestionSelect"];
	},
) {
	return (
		<div className="space-y-2 px-3 py-2.5">
			{answers.map((answer, index) => {
				let id = definition.questions[index]?.id;
				let chosen = answer.custom ?? (answer.choices ?? []).join(", ");
				return (
					<Related
						key={id ?? index}
						id={id}
						count={(id ? places?.[id] : undefined) ?? 0}
						label={`${answer.question} — ${chosen}`}
						className=""
						onEnter={onQuestionEnter}
						onLeave={onQuestionLeave}
						onSelect={onQuestionSelect}
					>
						{
							/* The question and what was chosen are one decision, so they are
						    one target: two stacked buttons led to the same prose. */
						}
						<p className="m-0 text-sm text-text-secondary">{answer.question}</p>
						<p className="m-0 text-sm font-medium text-text-primary">{chosen}</p>
					</Related>
				);
			})}
			{resolver && <p className="m-0 text-sm text-text-tertiary">Answered by @{resolver}</p>}
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
		places,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionFocus,
		onQuestionSelect,
		renderStep,
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
	let [confirming, setConfirming] = useState<"discard" | "cancel">();
	// Presence follows the current question and ends when it changes or the card goes.
	let focusing = useRef(onQuestionFocus);
	focusing.current = onQuestionFocus;
	useEffect(() => () => focusing.current?.(undefined), [active]);
	let [addError, setAddError] = useState<string>();
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

	if (status === "discarded") {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				<Discarded definition={definition} resolver={resolver} />
			</div>
		);
	}

	// A cancelled questionnaire has no answers, so it must be matched on status
	// alone — falling through would offer an editable form for a dead question.
	if (status === "cancelled") {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				<Cancelled resolver={resolver} />
			</div>
		);
	}

	if (status !== "open") {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				{answers
					? (
						<Resolved
							answers={answers}
							definition={definition}
							resolver={resolver}
							places={places}
							onQuestionEnter={onQuestionEnter}
							onQuestionLeave={onQuestionLeave}
							onQuestionSelect={onQuestionSelect}
						/>
					)
					: <p className="m-0 px-3 py-2.5 text-sm text-text-secondary">Saved decision</p>}
				{error && <Callout feedback={errorClassName} title="Couldn’t save" message={error} />}
				<ResolvedActions
					className="question-actions"
					disabled={disabled}
					onDiscard={onDiscard}
					onReopen={onReopen}
					submitting={submitting}
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
	let discard = onDiscard ?? onCancel;
	let previousAnswer = previousFor(priorAnswers, current.id);
	let step = (offset: number, from?: "primary") => {
		let question = definition.questions[index + offset];
		if (!question) return;
		setActive(question.id);
		setAddError(undefined);
		let arrived = index + offset;
		if (from) refocus.current = "primary";
		else if (arrived === 0) refocus.current = "next";
		else if (arrived === total - 1) refocus.current = "previous";
	};
	let titleId = `${base}-title-${active}`;

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
										label={current.question}
										className="question-title-link"
										inline
										onSelect={onQuestionSelect}
									>
										{current.question}
									</Related>
								</h4>
								{current.multiple && <p className="question-hint">Choose any</p>}
								{previousAnswer && (
									<p className="question-hint">
										Previously: {previousAnswer.labels.join(", ")} · @{previousAnswer.by}
									</p>
								)}
								{refining && <p className="question-hint" role="status">Chopin is refining…</p>}
							</div>
							<Presence
								people={collaborators.filter(person =>
									person.question === current.id
								)}
								render={renderPeople}
							/>
						</header>

						<fieldset disabled={disabled} className="question-options">
							<legend className="sr-only">{current.header}</legend>
							<Choices
								question={current}
								draft={projection.draft}
								disabled={disabled}
								name={`${base}-${current.id}`}
								onChange={change => {
									markHumanEdit();
									onChange?.(current.id, change);
								}}
								suggestedOptionId={projection.suggestion?.optionId}
							/>
							{drafts[current.id]?.mode === "custom" && drafts[current.id]!.custom.trim() && (
								<LegacyCustom
									question={current}
									draft={drafts[current.id]!}
									name={`${base}-${current.id}`}
								/>
							)}
							{current.options.length < MAX_SHARED_OPTIONS && (
								<AddOption
									key={current.id}
									question={current}
									offset={drafts[current.id]?.mode === "custom" && drafts[current.id]!.custom.trim()
										? 1
										: 0}
									disabled={disabled}
									onAdd={onAddOption
										? label => onAddOption(current.id, label)
										: undefined}
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
									{confirming === "cancel" ? "Cancel without answering?" : "Discard this decision?"}
								</span>
								<button
									type="button"
									onClick={() => setConfirming(undefined)}
									disabled={submitting}
									className="btn btn-sm btn-outline"
								>
									Keep it
								</button>
								<button
									type="button"
									onClick={confirming === "cancel" ? onCancel : discard}
									disabled={disabled || submitting}
									className="btn btn-sm btn-destructive"
								>
									{submitting
										? (confirming === "cancel" ? "Cancelling…" : "Discarding…")
										: confirming === "cancel"
										? "Cancel"
										: "Discard"}
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
											onClick={() =>
												step(1)}
											ref={next}
										>
											<ChevronIcon size={16} />
										</button>
									</div>
								)}
								{onCancel && onDiscard && (
									<button
										type="button"
										onClick={() => setConfirming("cancel")}
										disabled={disabled || submitting}
										className="btn btn-sm btn-outline"
									>
										Cancel
									</button>
								)}
								{(discard || showActions) && (
									<button
										type="button"
										onClick={() => setConfirming("discard")}
										disabled={disabled || submitting}
										className="btn btn-sm btn-outline"
									>
										Discard
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
								{(onSubmit || showActions) && (!multiple || last) && (
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
							</>
						)}
				</footer>
			)}
		</div>
	);
}
