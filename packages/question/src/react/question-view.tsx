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
	onRelationEnter?: (question: string, relation: "subject" | "result") => void;
	onRelationLeave?: (question: string, relation: "subject" | "result") => void;
	/** Follows a relation to the prose it refers to. */
	onRelationSelect?: (question: string, relation: "subject" | "result") => void;
	/**
	 * How many passages each relation points at, by question.
	 *
	 * Absent where nothing links the two — the chat card, or a plan relation
	 * still waiting to be anchored. Without a destination the text stays inert
	 * prose rather than advertising a jump that would do nothing.
	 */
	relations?: Record<string, { subject: number; result: number }>;
	collaborators?: Collaborator[];
	/** Validation or synchronisation problem, announced to assistive tech. */
	error?: string;
	/** Rendered beside the heading; hosts use it for counts and provenance. */
	aside?: ReactNode;
};

function Badges({ people }: { people: Collaborator[] }) {
	if (people.length === 0) return null;
	return (
		<span className="flex min-w-0 flex-wrap gap-1" aria-label="Editing this question">
			{people.map(person => (
				<span
					key={person.client}
					title={`@${person.handle} is editing`}
					className="max-w-28 truncate rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
				>
					@{person.handle}
				</span>
			))}
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
		<fieldset disabled={disabled} className="m-0 border-0 p-0">
			<legend className="sr-only">{question.header}</legend>

			{question.options.map(option => {
				let selected = question.multiple
					? !!draft?.options[option.id]
					: draft?.choice === option.id;

				return (
					<label
						key={option.id}
						className="flex items-start gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-muted/60"
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
							className="mt-1 size-3.5 shrink-0 accent-primary"
						/>
						<span className="min-w-0">
							<span className="font-medium text-foreground">{option.label}</span>
							{option.description && (
								<span className="block text-xs text-muted-foreground">{option.description}</span>
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

	return (
		<div className="mt-2">
			<label className="flex items-start gap-2 text-sm">
				<input
					type={question.multiple ? "checkbox" : "radio"}
					name={question.multiple ? undefined : name}
					checked={active}
					disabled={disabled}
					onChange={event =>
						onChange?.({ mode: event.currentTarget.checked ? "custom" : "choices" })}
					className="mt-1 size-3.5 shrink-0 accent-primary"
				/>
				<span className="font-medium">Write a custom answer</span>
			</label>

			<textarea
				rows={2}
				maxLength={4000}
				value={draft?.custom ?? ""}
				disabled={disabled}
				aria-label={`Custom answer for ${question.header}`}
				placeholder="Type another answer"
				onFocus={() => onChange?.({ mode: "custom" })}
				onChange={event => onChange?.({ mode: "custom", custom: event.currentTarget.value })}
				className="mt-1.5 min-h-16 w-full resize-y rounded-md border border-input bg-input/20 px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
			/>
		</div>
	);
}

const LINK =
	"block w-full cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * Text that may refer to somewhere else.
 *
 * Rendered as a button only when there is somewhere to go, so a real element
 * carries the affordance and the keyboard handling rather than a paragraph
 * pretending to be one. Unlinked text stays a paragraph, takes no tab stop,
 * and offers no focus ring it could never show.
 */
function Related(
	{ id, relation, count, className, children, onEnter, onLeave, onSelect }: {
		id: string | undefined;
		relation: "subject" | "result";
		count: number;
		className: string;
		children: ReactNode;
		onEnter?: QuestionViewProps["onRelationEnter"];
		onLeave?: QuestionViewProps["onRelationLeave"];
		onSelect?: QuestionViewProps["onRelationSelect"];
	},
) {
	if (!id || count === 0) return <p className={`m-0 text-sm ${className}`}>{children}</p>;

	return (
		<button
			type="button"
			data-ace-question-id={id}
			data-ace-relation={relation}
			aria-label={count > 1 ? `Show in plan, ${count} places` : "Show in plan"}
			onClick={() => onSelect?.(id, relation)}
			onMouseEnter={() => onEnter?.(id, relation)}
			onMouseLeave={event =>
				event.currentTarget !== document.activeElement && onLeave?.(id, relation)}
			onFocus={() => onEnter?.(id, relation)}
			onBlur={event => !event.currentTarget.matches(":hover") && onLeave?.(id, relation)}
			className={`m-0 text-sm ${className} ${LINK}`}
		>
			{children}
			{count > 1 && (
				<span aria-hidden="true" className="ml-1.5 text-xs text-muted-foreground">
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
		relations,
		onRelationEnter,
		onRelationLeave,
		onRelationSelect,
	}: {
		answers: Answer[];
		definition: Definition;
		resolver?: string;
		relations?: QuestionViewProps["relations"];
		onRelationEnter?: QuestionViewProps["onRelationEnter"];
		onRelationLeave?: QuestionViewProps["onRelationLeave"];
		onRelationSelect?: QuestionViewProps["onRelationSelect"];
	},
) {
	return (
		<div className="space-y-2 px-3 py-2.5">
			{answers.map((answer, index) => {
				let id = definition.questions[index]?.id;
				let linked = id ? relations?.[id] : undefined;
				return (
					<div key={id ?? index} data-ace-question-id={id}>
						<Related
							id={id}
							relation="subject"
							count={linked?.subject ?? 0}
							className="text-muted-foreground"
							onEnter={onRelationEnter}
							onLeave={onRelationLeave}
							onSelect={onRelationSelect}
						>
							{answer.question}
						</Related>
						<Related
							id={id}
							relation="result"
							count={linked?.result ?? 0}
							className="font-medium text-foreground"
							onEnter={onRelationEnter}
							onLeave={onRelationLeave}
							onSelect={onRelationSelect}
						>
							{answer.custom ?? (answer.choices ?? []).join(", ")}
						</Related>
					</div>
				);
			})}
			{resolver && <p className="m-0 text-xs text-muted-foreground">Answered by @{resolver}</p>}
		</div>
	);
}

/** A question nobody answered. There is nothing to show but who ended it. */
function Cancelled({ resolver }: { resolver?: string }) {
	return (
		<div className="px-3 py-2.5">
			<p className="m-0 text-sm text-muted-foreground">
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
		aside,
		relations,
		onRelationEnter,
		onRelationLeave,
		onRelationSelect,
	} = props;

	let base = useId();
	let [active, setActive] = useState(() => definition.questions[0]?.id);
	// Cancelling cannot be undone and the agent is waiting, so it takes a
	// second, deliberate click rather than a modal nobody reads.
	let [confirming, setConfirming] = useState(false);
	let tabs = useRef<HTMLDivElement>(null);

	// A question can disappear if the definition is replaced; fall back rather
	// than rendering an empty panel.
	useEffect(() => {
		setActive(current =>
			definition.questions.some(question => question.id === current)
				? current
				: definition.questions[0]?.id
		);
	}, [definition]);

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
				{aside}
				<Cancelled resolver={resolver} />
			</div>
		);
	}

	if (status !== "open" && answers) {
		return (
			<div>
				{aside}
				<Resolved
					answers={answers}
					definition={definition}
					resolver={resolver}
					relations={relations}
					onRelationEnter={onRelationEnter}
					onRelationLeave={onRelationLeave}
					onRelationSelect={onRelationSelect}
				/>
			</div>
		);
	}

	let multiple = definition.questions.length > 1;
	let current = definition.questions.find(question => question.id === active);
	let last = definition.questions.at(-1)?.id === active;

	return (
		<div>
			{multiple && (
				<div
					ref={tabs}
					role="tablist"
					aria-label="Questions"
					className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2"
				>
					{definition.questions.map((question, index) => {
						let done = answered(question, drafts[question.id]);
						let people = collaborators.filter(person => person.question === question.id);

						return (
							<button
								key={question.id}
								data-ace-question-id={question.id}
								data-ace-relation="subject"
								id={`${base}-tab-${question.id}`}
								type="button"
								role="tab"
								aria-selected={question.id === active}
								aria-controls={`${base}-panel`}
								aria-label={done ? `${question.header}, answered` : question.header}
								tabIndex={question.id === active ? 0 : -1}
								// Switching question, and only that. A tab used to ask to be
								// taken to the question's prose as well, which read as
								// intentional for as long as nothing was listening — wired
								// up, it scrolls the plan out from under a reader who was
								// stepping through the tabs to read them. Hovering a tab
								// already lights what its question is about, and the panel
								// below carries the control that says "show in plan".
								onClick={() => setActive(question.id)}
								onMouseEnter={() => onRelationEnter?.(question.id, "subject")}
								onMouseLeave={event =>
									event.currentTarget !== document.activeElement
									&& onRelationLeave?.(question.id, "subject")}
								onFocus={() => onRelationEnter?.(question.id, "subject")}
								onBlur={event =>
									!event.currentTarget.matches(":hover")
									&& onRelationLeave?.(question.id, "subject")}
								onKeyDown={event => move(event, index)}
								className={`shrink-0 rounded-t-md px-2.5 py-1 text-xs font-medium transition-colors ${
									question.id === active
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								<span aria-hidden="true">{done ? "✓" : index + 1}</span> {question.header}
								{people.length > 0 && (
									<span className="ml-1 text-[0.625rem] text-muted-foreground">
										{people.length}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}

			{aside}

			{current && (
				<section
					data-ace-question-id={current.id}
					data-ace-relation="subject"
					id={`${base}-panel`}
					role={multiple ? "tabpanel" : undefined}
					className="px-3 py-2.5"
					onMouseEnter={() => onRelationEnter?.(current.id, "subject")}
					onMouseLeave={event =>
						!event.currentTarget.contains(document.activeElement)
						&& onRelationLeave?.(current.id, "subject")}
					onFocusCapture={() => onRelationEnter?.(current.id, "subject")}
					onBlurCapture={event =>
						!event.currentTarget.contains(event.relatedTarget)
						&& !event.currentTarget.matches(":hover")
						&& onRelationLeave?.(current.id, "subject")}
				>
					<header className="flex items-baseline justify-between gap-2">
						<h4 className="m-0 text-sm font-semibold text-foreground">{current.header}</h4>
						<Badges people={collaborators.filter(person => person.question === current.id)} />
					</header>

					{/* Never the whole panel: below this is a form. */}
					<Related
						id={current.id}
						relation="subject"
						count={relations?.[current.id]?.subject ?? 0}
						className="mt-1 mb-2 text-muted-foreground"
						onSelect={onRelationSelect}
					>
						{current.question}
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
			)}

			{error && (
				<p role="alert" className="px-3 pb-2 text-xs text-destructive">
					{error}
				</p>
			)}

			{(onSubmit || onCancel) && (!multiple || last) && (
				<footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
					{onCancel && confirming && (
						<>
							<p className="m-0 mr-auto text-xs text-muted-foreground">
								Cancel without answering?
							</p>
							<button
								type="button"
								onClick={() => setConfirming(false)}
								disabled={submitting}
								className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
							>
								Keep it
							</button>
							<button
								type="button"
								onClick={onCancel}
								disabled={disabled || submitting}
								className="rounded-md px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
							>
								{submitting ? "Cancelling…" : "Yes, cancel"}
							</button>
						</>
					)}
					{onCancel && !confirming && (
						<button
							type="button"
							onClick={() => setConfirming(true)}
							disabled={disabled || submitting}
							className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
						>
							Cancel
						</button>
					)}
					{onSubmit && !confirming && (
						<button
							type="button"
							onClick={onSubmit}
							disabled={disabled || submitting}
							className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
						>
							{submitting ? "Submitting…" : "Submit"}
						</button>
					)}
				</footer>
			)}
		</div>
	);
}
