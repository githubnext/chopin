/**
 * A questionnaire, as the decisions pane shows it.
 *
 * The definition is immutable and the answer is owned by the server's record,
 * so this never writes to the document — an agent rewriting the plan cannot
 * overwrite a decision. What the plan node carries is a projection, kept so
 * the source reads correctly on its own.
 */

import { useEffect, useRef, useState } from "react";
import { cardStatus } from "@chopin/dialect";
import { DecisionIcon, MessageForwardIcon } from "@chopin/icons";
import { QuestionView, useQuestionnaire } from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { Provenance, SidecarCard } from "../card";
import { useCardMeta } from "../card-meta";
import { ContentSwapLayer } from "../content-swap";
import { EvidenceHover } from "./evidence-hover";
import { Face } from "../face";
import { widgets$ } from "../widget-options";
import { useTransitionPresence } from "../transition-presence";

import type { Question } from "@chopin/protocol";
import type { ReactNode } from "react";
import type { Transport } from "@chopin/question/react";
import type { Answer } from "@chopin/question";
import type { Questionnaire, QuestionnaireNode } from "@chopin/dialect";
import type { QuestionStepMotion } from "../widget-options";

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
	presentation?: "inline" | "list";
	motionImmediately?: () => boolean;
	onCardSource?: (questionnaireId: string) => void;
	evidence?: ReactNode | null;
	wire?: Transport;
	connected?: boolean;
	/** Whether this viewer may change or resolve the shared draft. */
	canEdit?: boolean;
	/** How much prose each decision lives in. */
	places?: { [question: string]: number };
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
	/** Take the reader to that prose. Without it the shared view's jump is inert. */
	onQuestionSelect?: (question: string) => void;
	motion?: QuestionStepMotion;
};

export type CardPresentation = "hidden" | "settled-line" | "resolved" | "open";

export function cardPresentation(
	value: Questionnaire,
	meta: Question.CardMeta | undefined,
	where: "inline" | "list",
): CardPresentation {
	let status = meta?.status ?? cardStatus(value);
	if (status === "open" || status === "reopened") return "open";
	if (where === "list") return "resolved";
	if (status === "discarded" || meta?.hasProse) return "hidden";
	// A card can resolve before its metadata reaches this client. Its document
	// projection is still a decided card, and all prose-less decisions settle inline.
	return "settled-line";
}

export function QuestionnaireCard(
	{
		canEdit = true,
		connected = false,
		evidence,
		motionImmediately,
		onCardSource,
		presentation = "inline",
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
		motion,
		meta,
		places,
		value,
		wire,
	}: QuestionnaireCardProps,
) {
	let resolved = answers(value);
	let current = meta?.status ?? cardStatus(value);
	let pointing = { places, onQuestionEnter, onQuestionLeave, onQuestionSelect };

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
		return <div data-plan-sidecar-questionnaire={value.id} data-card-hidden="" hidden />;
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
	onQuestionEnter?: (question: string) => void;
	onQuestionLeave?: (question: string) => void;
	onQuestionSelect?: (question: string) => void;
};

type QuestionStep = { children: ReactNode; question: string };

/** Who is in this decision, overlapping, at most eight. */
function People({ handles }: { handles: string[] }) {
	let unique = [...new Set(handles)];
	if (unique.length === 0) return null;
	let shown = unique.slice(0, 8);

	return (
		<span
			aria-label={`In this decision: ${unique.join(", ")}`}
			className="flex items-center"
			role="group"
		>
			{shown.map((handle, index) => (
				<span className={index > 0 ? "-ml-1.5" : ""} key={handle}>
					<Face handle={handle} ring="page" size={22} />
				</span>
			))}
			{unique.length > 8 && (
				<span className="ml-1 text-sm text-text-tertiary tabular-nums">+{unique.length - 8}</span>
			)}
		</span>
	);
}

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
	{ canEdit, connected, meta, motion, onCardSource, value, wire, ...pointing }:
		& {
			canEdit: boolean;
			connected: boolean;
			meta?: Question.CardMeta;
			motion?: QuestionStepMotion;
			onCardSource?: (questionnaireId: string) => void;
			value: Questionnaire;
			wire?: Transport;
		}
		& Pointing,
) {
	let state = useQuestionnaire({
		id: value.id,
		bridge: wire,
		connected,
		definition: definition(value),
	});

	let answerable = connected && !!state.definition;
	let editable = canEdit && answerable;
	let previous = previousAnswers(value);
	let people = [
		...new Set([
			...(meta?.involved ?? []),
			...state.collaborators.map(person => person.handle),
		]),
	];

	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
		>
			<QuestionView
				aside={
					<span className="flex items-center gap-2">
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
						<People handles={people} />
					</span>
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
				showActions
				onAddOption={editable ? state.addOption : undefined}
				onCancel={editable ? state.cancel : undefined}
				onDiscard={editable ? state.discard : undefined}
				onChange={editable ? state.change : undefined}
				onSubmit={editable ? state.submit : undefined}
				renderStep={motion
					? ({ children, question }) => (
						<QuestionStepSwap motion={motion} question={question}>
							{children}
						</QuestionStepSwap>
					)
					: undefined}
				status="open"
				submitting={state.submitting}
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

function labels(value: Questionnaire): string[] {
	return value.questions.flatMap(question => {
		let selected = question.choices?.flatMap(id => {
			let option = question.options.find(candidate => candidate.id === id);
			return option ? [option.label] : [];
		});
		return selected?.length ? selected : question.answer ? [question.answer] : [];
	});
}

function SettledLine(
	{ canEdit, connected, meta, value, wire }: {
		canEdit: boolean;
		connected: boolean;
		meta?: Question.CardMeta;
		value: Questionnaire;
		wire?: Transport;
	},
) {
	let owner = meta?.owner ?? value.by;
	let chosen = labels(value);
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
			className="m-0 flex items-center gap-2 text-sm text-text-secondary"
			data-card-settled=""
			data-plan-sidecar-questionnaire={value.id}
		>
			<DecisionIcon aria-hidden="true" size={14} />
			<span>
				Decided: {chosen.length ? chosen.join(", ") : "Saved decision"}
				{owner ? ` · @${owner}` : ""}
			</span>
			{meta?.origin === "conversation" && (
				<span className="text-text-tertiary">
					{meta.proseOrphaned ? " · prose removed" : "writing up…"}
				</span>
			)}
			{meta?.proseOrphaned && (
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
	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
			settled
			// Metadata owns lifecycle attribution; older nodes retain their document fallback.
			status={
				<Provenance
					at={meta ? meta.decidedAt : value.at}
					by={meta ? meta.resolver : value.by}
					verb={discarded ? "Discarded" : "Answered"}
				/>
			}
		>
			<QuestionView
				answers={resolved}
				definition={definition(value)}
				disabled={!editable}
				drafts={{}}
				error={error}
				errorClassName="editor-motion-feedback"
				onDiscard={editable ? () => request("question:discard") : undefined}
				onReopen={editable ? () => request("question:reopen") : undefined}
				resolver={discarded ? meta?.resolver : undefined}
				status={discarded ? "discarded" : "answered"}
				submitting={submitting}
				{...pointing}
			/>
		</SidecarCard>
	);
}

function InlineQuestionnaire({ value }: { value: Questionnaire }) {
	let options = useCellValue(widgets$);
	let meta = useCardMeta(options.cardMeta, value.id);
	let evidence = value.thread && (meta?.status === "open" || meta?.status === "reopened")
		? options.evidence?.(value.id)
		: null;

	return (
		<QuestionnaireCard
			canEdit={options.canEdit}
			connected={options.connected}
			evidence={evidence}
			motion={options.questionMotion}
			motionImmediately={options.motionImmediately}
			onCardSource={options.onCardSource}
			meta={meta}
			onQuestionEnter={question => options.questions?.highlight(value.id, question)}
			onQuestionLeave={() => options.questions?.clear()}
			onQuestionSelect={question => options.questions?.reveal(value.id, question)}
			places={options.questions?.counts(value.id)}
			value={value}
			wire={options.wire}
		/>
	);
}

export function renderQuestionnaire(node: QuestionnaireNode) {
	// React renders decorators after Lexical's read transaction has ended.
	return <InlineQuestionnaire value={node.getQuestionnaire()} />;
}
