/**
 * A questionnaire, as the decisions pane shows it.
 *
 * The definition is immutable and the answer is owned by the server's record,
 * so this never writes to the document — an agent rewriting the plan cannot
 * overwrite a decision. What the plan node carries is a projection, kept so
 * the source reads correctly on its own.
 */

import { QuestionView, useQuestionnaire } from "@chopin/question/react";

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

export type Relation = "subject" | "result";

export type QuestionnaireCardProps = {
	value: Questionnaire;
	wire?: Transport;
	connected?: boolean;
	/** How much prose each question and answer resolves to. */
	relations?: { [question: string]: { subject: number; result: number } };
	onRelationEnter?: (question: string, relation: Relation) => void;
	onRelationLeave?: (question: string, relation: Relation) => void;
};

export function QuestionnaireCard(
	{ connected = false, onRelationEnter, onRelationLeave, relations, value, wire }:
		QuestionnaireCardProps,
) {
	let resolved = answers(value);
	let pointing = { relations, onRelationEnter, onRelationLeave };

	return resolved
		? <Decided resolved={resolved} value={value} {...pointing} />
		: <Undecided connected={connected} value={value} wire={wire} {...pointing} />;
}

type Pointing = {
	relations?: { [question: string]: { subject: number; result: number } };
	onRelationEnter?: (question: string, relation: Relation) => void;
	onRelationLeave?: (question: string, relation: Relation) => void;
};

function Undecided(
	{ connected, value, wire, ...pointing }:
		& { connected: boolean; value: Questionnaire; wire?: Transport }
		& Pointing,
) {
	let state = useQuestionnaire({
		id: value.id,
		bridge: wire,
		connected,
		definition: definition(value),
	});

	let answerable = connected && !!state.definition;

	return (
		<div
			className="overflow-hidden rounded-lg border border-border bg-card"
			data-plan-sidecar-questionnaire={value.id}
		>
			<QuestionView
				aside={<Heading count={value.questions.length} label="Open question" />}
				collaborators={state.collaborators}
				definition={state.definition ?? definition(value)}
				// A draft that has not synced cannot be edited without discarding
				// what other people have already put into it.
				disabled={!answerable || state.syncing || state.submitting}
				drafts={state.drafts}
				error={state.error}
				onCancel={answerable ? state.cancel : undefined}
				onChange={answerable ? state.change : undefined}
				onSubmit={answerable ? state.submit : undefined}
				status="open"
				submitting={state.submitting}
				{...pointing}
			/>
		</div>
	);
}

function Decided(
	{ resolved, value, ...pointing }: { resolved: Answer[]; value: Questionnaire } & Pointing,
) {
	return (
		<div
			className="overflow-hidden rounded-lg border border-border bg-card"
			data-plan-sidecar-questionnaire={value.id}
		>
			<QuestionView
				answers={resolved}
				aside={<Heading count={value.questions.length} label="Decision" />}
				definition={definition(value)}
				disabled
				drafts={{}}
				status="answered"
				{...pointing}
			/>
		</div>
	);
}

function Heading({ count, label }: { count: number; label: string }) {
	return (
		<header className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2">
			<span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
				{label}
			</span>
			{count > 1 && <span className="text-xs text-muted-foreground">{count} questions</span>}
		</header>
	);
}

export function renderQuestionnaire(_node: QuestionnaireNode) {
	// The node stays in the plan for exports and agent reads, but its full form
	// belongs in the decisions pane. What remains here is a zero-size anchor.
	return null;
}
