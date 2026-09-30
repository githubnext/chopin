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

import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronIcon, DecisionIcon, PlusIcon, WarningIcon } from "@chopin/icons";

import { answered } from "../draft";

import type { ReactNode } from "react";
import type { Draft, Drafts } from "../draft";
import type { Answer, Definition, Item } from "../schema";

export type Collaborator = {
	/** Stable per connection, so one person on two devices shows twice. */
	client: string;
	handle: string;
	question?: string;
};

export type QuestionStepRenderProps = {
	children: ReactNode;
	question: string;
};

export type QuestionViewProps = {
	definition: Definition;
	drafts: Drafts;
	/** Absent once resolved: a decision is not re-opened, a new question is asked. */
	onChange?: (question: string, change: Partial<Draft>) => void;
	onSubmit?: () => void;
	onCancel?: () => void;
	disabled?: boolean;
	submitting?: boolean;
	status?: "open" | "answered" | "cancelled";
	/** Shown instead of controls once the questionnaire has resolved. */
	answers?: Answer[];
	resolver?: string;
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
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
	{ question, draft, disabled, name, onChange }: {
		question: Item;
		draft: Draft | undefined;
		disabled: boolean;
		name: string;
		onChange?: (change: Partial<Draft>) => void;
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

/** The last row: a prompt to add an option, which becomes the field for it. */
function Custom(
	{ question, draft, disabled, name, onChange }: {
		question: Item;
		draft: Draft | undefined;
		disabled: boolean;
		name: string;
		onChange?: (change: Partial<Draft>) => void;
	},
) {
	let active = draft?.mode === "custom";
	let textarea = useRef<HTMLTextAreaElement>(null);
	let row = useRef<HTMLInputElement>(null);
	let focusOnReveal = useRef(false);
	let focusOnClose = useRef(false);

	useEffect(() => {
		if (active && focusOnReveal.current) textarea.current?.focus();
		else if (!active && focusOnClose.current) row.current?.focus();
		focusOnReveal.current = false;
		focusOnClose.current = false;
	}, [active]);

	useEffect(() => {
		let viewport = window.visualViewport;
		if (!viewport) return;
		let height = viewport.height;
		let reveal = () => {
			let previous = height;
			height = viewport.height;
			let control = textarea.current;
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

	if (!active) {
		return (
			<label className="question-choice-row question-option question-add">
				<input
					type={question.multiple ? "checkbox" : "radio"}
					name={question.multiple ? undefined : name}
					checked={false}
					disabled={disabled}
					aria-label="Add an option"
					ref={row}
					onChange={() => {
						focusOnReveal.current = true;
						onChange?.({ mode: "custom" });
					}}
					className="question-input"
				/>
				<Key>
					<PlusIcon />
				</Key>
				<span className="question-text">Add an option</span>
			</label>
		);
	}

	return (
		<div className="question-choice-row question-option question-adding">
			<Key>{letter(question.options.length)}</Key>
			<textarea
				rows={1}
				maxLength={4000}
				value={draft?.custom ?? ""}
				disabled={disabled}
				aria-label="Add an option"
				placeholder="Add an option"
				onChange={event => onChange?.({ custom: event.currentTarget.value })}
				onKeyDown={event => {
					if (event.key === "Escape") {
						// Closing removes the focused field; hand focus back to its row.
						focusOnClose.current = true;
						onChange?.({ mode: "choices" });
					} else if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						event.currentTarget.blur();
					}
				}}
				className="question-custom-answer question-field"
				ref={textarea}
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

export function QuestionView(props: QuestionViewProps) {
	let {
		definition,
		drafts,
		onChange,
		onSubmit,
		onCancel,
		disabled = false,
		submitting = false,
		status = "open",
		answers,
		resolver,
		collaborators = [],
		error,
		errorClassName,
		aside,
		places,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
		renderStep,
	} = props;

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

	if (status !== "open" && answers) {
		return (
			<div>
				{single && <DecisionHeading />}
				{aside}
				<Resolved
					answers={answers}
					definition={definition}
					resolver={resolver}
					places={places}
					onQuestionEnter={onQuestionEnter}
					onQuestionLeave={onQuestionLeave}
					onQuestionSelect={onQuestionSelect}
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
	let ready = answered(current, drafts[current.id]);
	let step = (offset: number, from?: "primary") => {
		let question = definition.questions[index + offset];
		if (!question) return;
		setActive(question.id);
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
						onFocusCapture={() =>
							onQuestionEnter?.(current.id)}
						onBlurCapture={event =>
							!event.currentTarget.contains(event.relatedTarget)
							&& !event.currentTarget.matches(":hover")
							&& onQuestionLeave?.(current.id)}
					>
						<header className="question-head">
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
							</div>
							<Badges
								people={collaborators.filter(person =>
									person.question === current.id
								)}
							/>
						</header>

						<fieldset disabled={disabled} className="question-options">
							<legend className="sr-only">{current.header}</legend>
							<Choices
								question={current}
								draft={drafts[current.id]}
								disabled={disabled}
								name={`${base}-${current.id}`}
								onChange={change => onChange?.(current.id, change)}
							/>
							<Custom
								question={current}
								draft={drafts[current.id]}
								disabled={disabled}
								name={`${base}-${current.id}`}
								onChange={change => onChange?.(current.id, change)}
							/>
						</fieldset>
					</section>
				);

				return renderStep ? renderStep({ children: panel, question: current.id }) : panel;
			})()}

			{error && (
				<div
					className={`plan-research-callout question-callout${
						errorClassName ? ` ${errorClassName}` : ""
					}`}
					data-motion-feedback={errorClassName ? "alert" : undefined}
					role="alert"
				>
					<span aria-hidden="true" className="plan-research-badge">
						<WarningIcon />
					</span>
					<p>
						<strong>Couldn’t save</strong>
						{error}
					</p>
				</div>
			)}

			{(onSubmit || onCancel || multiple) && (
				<footer
					className="question-actions"
					data-confirm={onCancel && confirming ? "" : undefined}
				>
					{onCancel && confirming
						? (
							<>
								<span className="question-confirm">Discard this decision?</span>
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
									onClick={onCancel}
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
								{onCancel && (
									<button
										type="button"
										onClick={() => setConfirming(true)}
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
								{onSubmit && (!multiple || last) && (
									<button
										type="button"
										onClick={onSubmit}
										disabled={disabled || submitting || !ready}
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
