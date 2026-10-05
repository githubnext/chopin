/** A provisional spike choice in Chat, separate from the card's final decision. */

import { useState } from "react";
import { DecisionIcon } from "@chopin/icons";

import { capitalize } from "./model";

import type { Chat, ConversationPlan } from "@chopin/protocol";
import type { Transport } from "@chopin/question/react";
import type { Question } from "@chopin/protocol";
import type { Questionnaire } from "@chopin/dialect";

type ScopedChoice = Extract<NonNullable<Chat.Entry["decision"]>, { kind: "scoped-choice" }>;

export function ScopedChoicePrompt({
	canEdit,
	connected,
	decision,
	latest,
	meta,
	state,
	value,
	wire,
}: {
	canEdit: boolean;
	connected: boolean;
	decision: ScopedChoice;
	latest: boolean;
	meta?: Question.CardMeta;
	state?: ConversationPlan.State;
	value?: Questionnaire;
	wire?: Transport;
}) {
	let [submitting, setSubmitting] = useState(false);
	let [acknowledged, setAcknowledged] = useState(false);
	let [error, setError] = useState("");
	let thread = state?.threads.find(item => item.id === decision.threadId);
	let options = value?.id === decision.cardId
		? value.questions[0]?.options.filter(item => item.id === decision.optionId)
		: undefined;
	let option = options?.length === 1 ? options[0] : undefined;
	let pending = thread?.pendingScopedChoice;
	let saved = state?.events.some(event =>
		event.type === "scoped-choice.saved" && event.proposalId === decision.proposalId
		&& event.cardId === decision.cardId && event.expectedGeneration === decision.generation
	);
	let current = latest && !saved && !!thread && !!pending
		&& pending.proposalId === decision.proposalId
		&& pending.cardId === decision.cardId && pending.optionId === decision.optionId
		&& pending.label === decision.label && pending.scope === decision.scope
		&& option?.label === decision.label
		&& thread.questionnaireId === decision.cardId
		&& (meta?.status === "open" || meta?.status === "reopened")
		&& meta.history.length === decision.generation;
	let enabled = current && canEdit && connected && !!wire && !submitting && !acknowledged;
	let actionId = `scoped-choice:${decision.proposalId}:${decision.generation}`;
	let save = async () => {
		if (!enabled || !thread || !wire) return;
		setSubmitting(true);
		setError("");
		try {
			await wire.ask("conversation-plan:scoped-choice-save", {
				actionId,
				threadId: decision.threadId,
				expectedVersion: thread.version,
				proposalId: decision.proposalId,
				cardId: decision.cardId,
				optionId: decision.optionId,
				expectedGeneration: decision.generation,
			});
			setAcknowledged(true);
		} catch {
			setError("Could not save this choice. Check the card and connection, then try again.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div
			aria-label={`Scoped choice: ${decision.label} for this spike`}
			className="flex flex-col gap-2 rounded-lg bg-inset px-3 py-2.5"
			data-scoped-choice={decision.proposalId}
			role="group"
		>
			<div className="flex items-start gap-2">
				<span className="grid size-5 shrink-0 place-items-center rounded-full bg-success-wash text-success-icon">
					<DecisionIcon aria-hidden="true" size={12} />
				</span>
				<p className="m-0 min-w-0 flex-1 text-sm font-medium text-text-primary">
					Save {decision.label} for this spike?
				</p>
			</div>
			<div className="grid gap-1 pl-7">
				{decision.sources.map(source => (
					<p
						className="m-0 min-w-0 break-words text-xs text-text-secondary"
						key={`${source.messageId}:${source.start}:${source.end}`}
					>
						<span className="font-medium text-text-primary">
							{source.author.kind === "member" ? capitalize(source.author.handle) : "Chopin"}
						</span>
						{" “"}
						{source.quote}
						{"”"}
					</p>
				))}
			</div>
			{!saved && !current && (
				<p className="m-0 pl-7 text-xs text-text-tertiary">
					{latest ? "This choice has changed." : "Updated below."}
				</p>
			)}
			{current && !canEdit && (
				<p className="m-0 pl-7 text-xs text-text-tertiary">
					This document is read-only.
				</p>
			)}
			{current && canEdit && !connected && (
				<p className="m-0 pl-7 text-xs text-text-tertiary">
					Reconnect to save this choice.
				</p>
			)}
			{error && <p className="m-0 pl-7 text-xs text-destructive-ink" role="alert">{error}</p>}
			{(canEdit || saved) && (
				<div className="flex justify-end">
					<button
						className="btn btn-sm btn-primary"
						disabled={!enabled}
						onClick={() => void save()}
						type="button"
					>
						{saved
							? "Saved for this spike"
							: submitting || acknowledged
							? "Saving…"
							: "Save for this spike"}
					</button>
				</div>
			)}
		</div>
	);
}
