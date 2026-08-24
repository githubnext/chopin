/**
 * A questionnaire, as the decisions pane shows it.
 *
 * The definition is immutable and the answer is owned by the server's record,
 * so this never writes to the document — an agent rewriting the plan cannot
 * overwrite a decision. What the plan node carries is a projection, kept so
 * the source reads correctly on its own.
 */

import { QuestionView, useQuestionnaire } from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { Provenance, SidecarCard } from "../card";
import { widgets$ } from "../widget-options";

import type { Transport } from "@chopin/question/react";
import type { Answer } from "@chopin/question";
import type { Questionnaire, QuestionnaireNode } from "@chopin/dialect";

/** The plan stores the chosen text; the shared view wants answer records. */
function answers(value: Questionnaire): Answer[] | undefined {
	if (value.questions.some(question => question.answer === undefined)) return undefined;
	return value.questions.map(question => ({
		question: question.prompt,
		custom: question.answer ?? "",
	}));
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
};

export function QuestionnaireCard(
	{
		canEdit = true,
		connected = false,
		onQuestionEnter,
		onQuestionLeave,
		onQuestionSelect,
		places,
		value,
		wire,
	}: QuestionnaireCardProps,
) {
	let resolved = answers(value);
	let pointing = { places, onQuestionEnter, onQuestionLeave, onQuestionSelect };

	return resolved
		? <Decided resolved={resolved} value={value} {...pointing} />
		: (
			<Undecided
				canEdit={canEdit}
				connected={connected}
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

function Undecided(
	{ canEdit, connected, value, wire, ...pointing }:
		& { canEdit: boolean; connected: boolean; value: Questionnaire; wire?: Transport }
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
				onCancel={editable ? state.cancel : undefined}
				onChange={editable ? state.change : undefined}
				onSubmit={editable ? state.submit : undefined}
				status="open"
				submitting={state.submitting}
				{...pointing}
			/>
		</SidecarCard>
	);
}

function Decided(
	{ resolved, value, ...pointing }: { resolved: Answer[]; value: Questionnaire } & Pointing,
) {
	return (
		<SidecarCard
			data-plan-sidecar-questionnaire={value.id}
			label={value.questions.length === 1 ? "Decision" : "Question"}
			padded={false}
			settled
			// Read provenance from the durable node so late joiners see it.
			status={<Provenance at={value.at} by={value.by} verb="Answered" />}
		>
			<QuestionView
				answers={resolved}
				definition={definition(value)}
				disabled
				drafts={{}}
				status="answered"
				{...pointing}
			/>
		</SidecarCard>
	);
}

function InlineQuestionnaire({ value }: { value: Questionnaire }) {
	let options = useCellValue(widgets$);

	return (
		<QuestionnaireCard
			canEdit={options.canEdit}
			connected={options.connected}
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
