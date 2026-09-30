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
import { QuestionView, useQuestionnaire } from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { Provenance, SidecarCard } from "../card";
import { useCardMeta } from "../card-meta";
import { ContentSwapLayer } from "../content-swap";
import { widgets$ } from "../widget-options";

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

export function QuestionnaireCard(
	{
		canEdit = true,
		connected = false,
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

	return current !== "open" && current !== "reopened"
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
				canEdit={canEdit}
				connected={connected}
				motion={motion}
				meta={meta}
				value={value}
				wire={wire}
				{...pointing}
			/>
		);
}

type Pointing = {
	places?: { [question: string]: number };
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
	{ canEdit, connected, meta, motion, value, wire, ...pointing }:
		& {
			canEdit: boolean;
			connected: boolean;
			meta?: Question.CardMeta;
			motion?: QuestionStepMotion;
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

	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
		>
			<QuestionView
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
				status={discarded ? "cancelled" : "answered"}
				submitting={submitting}
				{...pointing}
			/>
		</SidecarCard>
	);
}

function InlineQuestionnaire({ value }: { value: Questionnaire }) {
	let options = useCellValue(widgets$);
	let meta = useCardMeta(options.cardMeta, value.id);

	return (
		<QuestionnaireCard
			canEdit={options.canEdit}
			connected={options.connected}
			motion={options.questionMotion}
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
