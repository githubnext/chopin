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

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, CloseIcon } from "@chopin/icons";

import { answered } from "../draft";

import type { KeyboardEvent, ReactNode } from "react";
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
			<CheckIcon aria-hidden="true" size={16} />
			<span className="text-sm font-medium text-text-primary">Decision</span>
		</header>
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
		<fieldset disabled={disabled} className="m-0 border-0 p-0">
			<legend className="sr-only">{question.header}</legend>

			{question.options.map(option => {
				let selected = question.multiple
					? !!draft?.options[option.id]
					: draft?.choice === option.id;

				return (
					<label
						key={option.id}
						className="question-choice-row flex min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-hover"
					>
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
							className="mt-0.5 size-[18px] shrink-0 choice-control"
						/>
						<span className="min-w-0">
							<span className="font-medium text-text-primary">{option.label}</span>
							{option.description && (
								<span className="block text-sm text-text-secondary">{option.description}</span>
							)}
						</span>
					</label>
				);
			})}
		</fieldset>
	);
}

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
	let focusOnReveal = useRef(false);

	useEffect(() => {
		if (!active || !focusOnReveal.current) return;
		focusOnReveal.current = false;
		textarea.current?.focus();
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

	return (
		<div className="mt-2">
			<label className="question-choice-row flex min-w-0 items-start gap-2 rounded-md px-1 text-sm hover:bg-hover">
				<input
					type={question.multiple ? "checkbox" : "radio"}
					name={question.multiple ? undefined : name}
					checked={active}
					disabled={disabled}
					onChange={event => {
						focusOnReveal.current = event.currentTarget.checked;
						onChange?.({ mode: event.currentTarget.checked ? "custom" : "choices" });
					}}
					className="mt-0.5 size-[18px] shrink-0 choice-control"
				/>
				<span className="font-medium">Write a custom answer</span>
			</label>

			{active && (
				<textarea
					rows={2}
					maxLength={4000}
					value={draft?.custom ?? ""}
					disabled={disabled}
					aria-label={`Custom answer for ${question.header}`}
					placeholder="Type another answer"
					onChange={event => onChange?.({ custom: event.currentTarget.value })}
					className="question-custom-answer field mt-1.5 min-h-16 w-full resize-y px-2.5 py-2 text-sm transition placeholder:text-text-tertiary disabled:cursor-not-allowed"
					ref={textarea}
				/>
			)}
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
	{ id, count, label, className, children, onEnter, onLeave, onSelect }: {
		id: string | undefined;
		count: number;
		label: string;
		className: string;
		children: ReactNode;
		onEnter?: QuestionViewProps["onQuestionEnter"];
		onLeave?: QuestionViewProps["onQuestionLeave"];
		onSelect?: QuestionViewProps["onQuestionSelect"];
	},
) {
	if (!id || count === 0) return <div className={className}>{children}</div>;

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
	// Cancelling cannot be undone and the agent is waiting, so it takes a
	// second, deliberate click rather than a modal nobody reads.
	let [confirming, setConfirming] = useState(false);
	let tabs = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!active) return;
		tabs.current?.querySelector<HTMLElement>(`#${CSS.escape(`${base}-tab-${active}`)}`)
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [active, base]);

	let move = useCallback((event: KeyboardEvent, index: number) => {
		let total = definition.questions.length;
		let next = index;

		if (event.key === "ArrowRight") next = (index + 1) % total;
		else if (event.key === "ArrowLeft") next = (index - 1 + total) % total;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = total - 1;
		else return;

		event.preventDefault();
		let question = definition.questions[next];
		if (!question) return;
		setActive(question.id);
		tabs.current?.querySelector<HTMLElement>(`#${CSS.escape(`${base}-tab-${question.id}`)}`)
			?.focus();
	}, [definition, base]);

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
	let last = index === definition.questions.length - 1;
	let unanswered = definition.questions.filter(question => !answered(question, drafts[question.id]))
		.length;
	let step = (offset: number) => {
		let question = definition.questions[index + offset];
		if (!question) return;
		setActive(question.id);
		// At either end the activated navigation button disappears. Move focus
		// to the selected tab so the new question is named instead of dropping
		// focus to the document body.
		tabs.current?.querySelector<HTMLElement>(`#${CSS.escape(`${base}-tab-${question.id}`)}`)
			?.focus();
	};

	return (
		<div>
			{single && <DecisionHeading />}
			{multiple && (
				<div
					ref={tabs}
					role="tablist"
					aria-label="Questions"
					data-focus-boundary=""
					className="flex gap-1 overflow-x-auto px-2 pt-2 hairline-b"
				>
					{definition.questions.map((question, index) => {
						let done = answered(question, drafts[question.id]);
						let people = collaborators.filter(person => person.question === question.id);

						return (
							<button
								key={question.id}
								data-ace-question-id={question.id}
								id={`${base}-tab-${question.id}`}
								type="button"
								role="tab"
								aria-selected={question.id === active}
								aria-controls={question.id === active ? `${base}-panel-${question.id}` : undefined}
								aria-label={done ? `${question.header}, answered` : question.header}
								tabIndex={question.id === active ? 0 : -1}
								// Switching question, and only that. A tab used to ask to be
								// taken to the question's prose as well, which read as
								// intentional for as long as nothing was listening — wired
								// up, it scrolls the plan out from under a reader who was
								// stepping through the tabs to read them. Hovering a tab
								// already lights where its decision lives, and the panel
								// below carries the control that says "show in plan".
								onClick={() => setActive(question.id)}
								onMouseEnter={() => onQuestionEnter?.(question.id)}
								onMouseLeave={event =>
									event.currentTarget !== document.activeElement
									&& onQuestionLeave?.(question.id)}
								onFocus={() => onQuestionEnter?.(question.id)}
								onBlur={event =>
									!event.currentTarget.matches(":hover") && onQuestionLeave?.(question.id)}
								onKeyDown={event => move(event, index)}
								className={`question-tab max-w-64 shrink-0 rounded-t-md px-2.5 py-1 text-left text-sm leading-tight font-medium whitespace-normal transition ${
									question.id === active
										? "bg-selected text-text-primary"
										: "text-text-tertiary hover:text-text-primary"
								}`}
							>
								<span aria-hidden="true">{done ? "✓" : index + 1}</span> {question.header}
								{people.length > 0 && (
									<span className="ml-1 text-sm text-text-tertiary tabular-nums">
										{people.length}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}

			{aside}

			{(() => {
				let panel = (
					<section
						aria-labelledby={multiple ? `${base}-tab-${current.id}` : undefined}
						data-ace-question-id={current.id}
						id={panelId}
						role={multiple ? "tabpanel" : undefined}
						className="px-3 py-2.5"
						onMouseEnter={() => onQuestionEnter?.(current.id)}
						onMouseLeave={event =>
							!event.currentTarget.contains(document.activeElement)
							&& onQuestionLeave?.(current.id)}
						onFocusCapture={() => onQuestionEnter?.(current.id)}
						onBlurCapture={event =>
							!event.currentTarget.contains(event.relatedTarget)
							&& !event.currentTarget.matches(":hover")
							&& onQuestionLeave?.(current.id)}
					>
						<header className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
							<h4 className="m-0 min-w-0 break-words text-sm font-semibold text-text-primary">
								{current.header}
							</h4>
							<Badges people={collaborators.filter(person => person.question === current.id)} />
						</header>

						{/* Never the whole panel: below this is a form. */}
						<Related
							id={current.id}
							count={places?.[current.id] ?? 0}
							label={current.question}
							className="mt-1 mb-2"
							onSelect={onQuestionSelect}
						>
							<p className="m-0 text-sm text-text-secondary">{current.question}</p>
						</Related>

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
					</section>
				);

				return renderStep ? renderStep({ children: panel, question: current.id }) : panel;
			})()}

			{error && (
				<p
					className={`${
						errorClassName ? `${errorClassName} ` : ""
					}px-3 pb-2 text-sm text-destructive-ink`}
					data-motion-feedback={errorClassName ? "alert" : undefined}
					role="alert"
				>
					{error}
				</p>
			)}

			{(onSubmit || onCancel || multiple) && (
				<footer className="question-actions flex flex-wrap items-center justify-end gap-2 px-3 py-2 hairline-t">
					{multiple && !confirming && (
						<p className="m-0 mr-auto text-sm text-text-tertiary tabular-nums">
							{index + 1} of {definition.questions.length} · {unanswered} unanswered
						</p>
					)}
					{onCancel && confirming && (
						<>
							<p className="m-0 mr-auto text-sm text-text-secondary">
								Cancel without answering?
							</p>
							<button
								type="button"
								onClick={() => setConfirming(false)}
								disabled={submitting}
								className="btn btn-sm btn-secondary"
							>
								Keep it
							</button>
							<button
								type="button"
								onClick={onCancel}
								disabled={disabled || submitting}
								className="btn btn-sm btn-destructive"
							>
								<CloseIcon aria-hidden="true" size={16} />
								{submitting ? "Cancelling…" : "Yes, cancel"}
							</button>
						</>
					)}
					{multiple && !confirming && index > 0 && (
						<button
							type="button"
							onClick={() => step(-1)}
							className="btn btn-sm btn-secondary"
						>
							Back
						</button>
					)}
					{onCancel && !confirming && (
						<button
							type="button"
							onClick={() => setConfirming(true)}
							disabled={disabled || submitting}
							className="btn btn-sm btn-secondary"
						>
							<CloseIcon aria-hidden="true" size={16} />
							Cancel
						</button>
					)}
					{multiple && !confirming && !last && (
						<button
							type="button"
							onClick={() => step(1)}
							className="btn btn-sm btn-primary"
						>
							Next
						</button>
					)}
					{onSubmit && !confirming && (!multiple || last) && (
						<button
							type="button"
							onClick={onSubmit}
							disabled={disabled || submitting}
							className="btn btn-sm btn-primary"
						>
							<CheckIcon
								aria-hidden="true"
								data-plan-icon="check"
								size={16}
							/>
							{submitting
								? (single ? "Saving…" : "Submitting…")
								: (single ? "Save answer" : "Submit")}
						</button>
					)}
				</footer>
			)}
		</div>
	);
}
