/** System entries that show or link to a live decision card. */

import { DecisionIcon, DocumentIcon, SparkleIcon } from "@chopin/icons";
import { projectSuggestion, useQuestionnaire } from "@chopin/question/react";

import type { Questionnaire } from "@chopin/dialect";
import type { Definition, Drafts } from "@chopin/question";
import type { Chat, Question } from "@chopin/protocol";
import type { Transport, VisibleSuggestion } from "@chopin/question/react";

export type DecisionEntryProps = {
	entry: Chat.Entry & { decision: NonNullable<Chat.Entry["decision"]> };
	latest: boolean;
	value?: Questionnaire;
	meta?: Question.CardMeta;
	wire?: Transport;
	connected: boolean;
	canEdit: boolean;
	onOpenCard: (questionnaireId: string) => void;
};

type PromptEntry = Chat.Entry & {
	author: { kind: "system" };
	decision: Extract<NonNullable<Chat.Entry["decision"]>, { kind: "prompt" }>;
};

/** The document schema and questionnaire controller use slightly different field names. */
function definition(value: Questionnaire | undefined): Definition | undefined {
	if (!value) return undefined;
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

export function promptSelection(
	definition: Definition | undefined,
	drafts: Drafts,
	suggested: VisibleSuggestion | undefined,
): { optionId?: string; label?: string; visibleSuggestion?: VisibleSuggestion } {
	if (definition?.questions.length !== 1) return {};
	let question = definition.questions[0]!;
	if (question.multiple) return {};

	let projection = projectSuggestion(question, drafts[question.id], suggested);
	let optionId = projection.draft?.mode === "choices" ? projection.draft.choice : null;
	let option = optionId ? question.options.find(item => item.id === optionId) : undefined;
	if (!option) return {};
	return {
		optionId: option.id,
		label: option.label,
		...(projection.suggestion ? { visibleSuggestion: projection.suggestion } : {}),
	};
}

function decidedText(value: Questionnaire | undefined, meta: Question.CardMeta): string {
	let question = value?.questions[0];
	let labels = question?.choices?.flatMap(id => {
		let option = question.options.find(candidate => candidate.id === id);
		return option ? [option.label] : [];
	}) ?? [];
	if (labels.length === 0 && question?.answer) labels = [question.answer];
	let owner = meta.owner ?? value?.by;
	return `Decided: ${labels.join(", ") || "Saved decision"}${owner ? ` · ${owner}` : ""}`;
}

export function promptView(
	{ entry, latest, meta, value }: {
		entry: PromptEntry;
		latest: boolean;
		meta?: Question.CardMeta;
		value?: Questionnaire;
	},
): { state: "live" } | { state: "collapsed"; text: string } {
	if (meta?.status === "discarded") return { state: "collapsed", text: "Discarded" };
	if (meta?.status === "decided") {
		return { state: "collapsed", text: decidedText(value, meta) };
	}
	if (
		meta?.status === "reopened" && value
		&& entry.decision.generation !== meta.history.length
	) return { state: "collapsed", text: "Reopened" };
	if (!latest) return { state: "collapsed", text: "Superseded by a later prompt" };
	if (!meta || !value) return { state: "collapsed", text: "Decision unavailable" };
	if (meta.status !== "open" && meta.status !== "reopened") {
		return { state: "collapsed", text: "Decision unavailable" };
	}
	if (entry.decision.generation !== meta.history.length) {
		return {
			state: "collapsed",
			text: meta.status === "reopened" ? "Reopened" : "Decision changed",
		};
	}
	return { state: "live" };
}

function OpenInPlan({ id, onOpenCard }: { id: string; onOpenCard: (id: string) => void }) {
	return (
		<button
			aria-label="Open in plan"
			className="grid size-6 shrink-0 place-items-center rounded-md text-text-tertiary hover:bg-hover hover:text-text-secondary"
			onClick={() => onOpenCard(id)}
			title="Open in plan"
			type="button"
		>
			<DocumentIcon aria-hidden="true" size={14} />
		</button>
	);
}

export function DecisionPrompt(props: DecisionEntryProps) {
	let { entry, latest, meta, value, wire, connected, canEdit, onOpenCard } = props;
	let id = entry.decision.questionnaireId;
	let view = promptView({ entry: entry as PromptEntry, latest, meta, value });
	let definitionValue = definition(value);
	let title = value?.questions[0]?.prompt ?? entry.text.replace(/^Ready to decide:\s*/, "");
	let live = view.state === "live";
	let state = useQuestionnaire({
		id,
		bridge: live ? wire : undefined,
		connected: live && connected && canEdit,
		definition: definitionValue,
	});

	if (view.state === "collapsed") {
		return (
			<div className="flex items-center gap-2 text-sm text-text-tertiary" data-decision-prompt={id}>
				<DecisionIcon aria-hidden="true" size={14} />
				<span className="min-w-0 flex-1 truncate">{view.text}</span>
				<OpenInPlan id={id} onOpenCard={onOpenCard} />
			</div>
		);
	}

	let currentDefinition = state.definition ?? definitionValue;
	let selection = promptSelection(currentDefinition, state.drafts, meta?.suggested);
	let enabled = live && !!wire && !!meta && !!value && canEdit && connected
		&& !state.syncing && !state.submitting && !!selection.optionId;

	return (
		<div
			aria-label={`Decision prompt: ${title}`}
			className="flex flex-col gap-2 rounded-lg bg-inset px-3 py-2.5"
			data-decision-prompt={id}
			role="group"
		>
			<div className="flex items-start gap-2">
				<span className="grid size-5 shrink-0 place-items-center rounded-full bg-success-wash text-success-icon">
					<DecisionIcon aria-hidden="true" size={12} />
				</span>
				<p className="m-0 min-w-0 flex-1 text-sm font-medium text-text-primary">{title}</p>
				<OpenInPlan id={id} onOpenCard={onOpenCard} />
			</div>
			<p className="m-0 text-sm text-text-secondary">
				{selection.label
					? `${selection.visibleSuggestion ? "Suggested" : "Selected"}: ${selection.label}`
					: "Choose an option on the card"}
			</p>
			{state.error && <p className="m-0 text-sm text-destructive-ink" role="alert">{state.error}
			</p>}
			<div className="flex justify-end">
				<button
					className="btn btn-sm btn-primary"
					disabled={!enabled}
					onClick={() =>
						selection.visibleSuggestion
							? state.submit(selection.visibleSuggestion)
							: state.submit()}
					type="button"
				>
					{state.submitting ? "Saving…" : "Save decision"}
				</button>
			</div>
		</div>
	);
}

export function ActivityLine({ entry, onOpenCard }: DecisionEntryProps) {
	let { questionnaireId, label } = entry.decision;
	let labelStart = label ? entry.text.indexOf(label) : -1;
	let matchedLabel = labelStart >= 0 ? label : undefined;
	let content = matchedLabel === undefined
		? entry.text
		: (
			<>
				{entry.text.slice(0, labelStart)}
				{questionnaireId === "document"
					? matchedLabel
					: (
						<button
							className="font-medium text-text-secondary underline-offset-2 hover:underline"
							onClick={() => onOpenCard(questionnaireId)}
							type="button"
						>
							{matchedLabel}
						</button>
					)}
				{entry.text.slice(labelStart + matchedLabel.length)}
			</>
		);
	return (
		<div
			className="flex items-start gap-3 text-text-tertiary"
			data-chat-system
			data-decision-activity
		>
			<SparkleIcon aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
			<p className="m-0 min-w-0 text-sm break-words">
				{content}
			</p>
		</div>
	);
}
