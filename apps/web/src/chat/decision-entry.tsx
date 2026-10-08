/** System entries that show or link to a live decision card. */

import { DecisionIcon, SparkleIcon } from "@chopin/icons";
import {
	InlineCode,
	plainInlineText,
	projectSuggestion,
	useQuestionnaire,
} from "@chopin/question/react";

import type { Questionnaire } from "@chopin/dialect";
import type { Definition, Drafts } from "@chopin/question";
import type { Chat, ConversationPlan, Question } from "@chopin/protocol";
import type { Transport, VisibleSuggestion } from "@chopin/question/react";

export type DecisionEntryProps = {
	entry: Chat.Entry & { decision: NonNullable<Chat.Entry["decision"]> };
	latest: boolean;
	value?: Questionnaire;
	meta?: Question.CardMeta;
	wire?: Transport;
	connected: boolean;
	canEdit: boolean;
	/** Current stances on the card's conversation thread. */
	stances?: readonly ConversationPlan.Stance[];
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
	return `Decided: ${labels.join(", ") || "Saved decision"}${owner ? ` · @${owner}` : ""}`;
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

/** People objecting to the shown option, or to the decision when no option is shown. */
export function objectors(
	stances: readonly ConversationPlan.Stance[],
	optionId: string | undefined,
): number {
	return new Set(
		stances.filter(stance =>
			stance.position === "oppose"
			&& (!optionId || !stance.optionId || stance.optionId === optionId)
		).map(stance => stance.participant),
	).size;
}

/** The card is the one place to save or reopen; Chat only points to it. */
function OpenCard(
	{ id, onOpenCard, title }: { id: string; onOpenCard: (id: string) => void; title: string },
) {
	return (
		<span className="whitespace-nowrap">
			{"· "}
			<button
				aria-label={`Open card: ${plainInlineText(title)}`}
				className="chat-inline-link font-medium text-brand-ink underline-offset-2 hover:underline"
				onClick={() => onOpenCard(id)}
				type="button"
			>
				Open card
			</button>
		</span>
	);
}

export function DecisionPrompt(props: DecisionEntryProps) {
	let { entry, latest, meta, value, wire, connected, canEdit, stances = [], onOpenCard } = props;
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
	let selection = live
		? promptSelection(state.definition ?? definitionValue, state.drafts, meta?.suggested)
		: {};
	let objections = objectors(stances, selection.optionId);

	return (
		<div
			className="flex items-start gap-2 text-sm text-text-tertiary"
			data-decision-prompt={id}
			{...(live
				? { "aria-label": `Decision prompt: ${plainInlineText(title)}`, role: "group" }
				: {})}
		>
			<DecisionIcon aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
			<p className="m-0 min-w-0 flex-1 break-words">
				{view.state === "collapsed" ? view.text : (
					<>
						{selection.label
							? (
								<>
									{"Ready to settle: "}
									<span className="font-medium text-text-secondary">
										<InlineCode text={selection.label} />
									</span>
								</>
							)
							: "Needs a choice"}
						{objections > 0 && (
							<>
								{" "}
								<span className="whitespace-nowrap">
									{"· "}
									<span className="text-warning-ink">
										{objections} {objections === 1 ? "objection" : "objections"}
									</span>
								</span>
							</>
						)}
					</>
				)} <OpenCard id={id} onOpenCard={onOpenCard} title={title} />
			</p>
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
