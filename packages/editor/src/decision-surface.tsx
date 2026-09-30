/** The same compact decision facts in the hover preview and pinned popover. */

import { ChosenList } from "@chopin/question/react";
import { ClockIcon, CloseIcon, MessageForwardIcon } from "@chopin/icons";

import { decidedOn, discussionLine } from "./decision-format";
import { Face } from "./face";

import type { ReactNode, Ref } from "react";
import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";

export function DecisionSummary(
	{
		actions,
		full = false,
		meta,
		value,
	}: {
		actions?: ReactNode;
		full?: boolean;
		meta: Question.CardMeta;
		value: Questionnaire;
	},
) {
	let question = value.questions[0];
	if (!question) return null;
	let selected = question.choices?.length
		? question.choices
		: question.options.filter(option => option.label === question.answer).map(option => option.id);
	let answer: Question.Answer = {
		question: question.prompt,
		optionIds: selected,
		choices: question.options.filter(option => selected.includes(option.id)).map(option =>
			option.label
		),
	};
	let item: Question.Item = {
		id: question.id,
		header: question.header,
		question: question.prompt,
		multiple: question.multiple,
		options: question.options.map(option => ({
			id: option.id,
			label: option.label,
			description: option.description ?? "",
		})),
	};
	let custom = selected.length === 0 && question.answer ? question.answer : undefined;
	let owner = meta.owner ?? value.by;
	let at = meta.decidedAt ?? (value.at ? Date.parse(value.at) / 1_000 : undefined);
	let handles = owner
		? [owner, ...meta.involved.filter(handle => handle !== owner)].slice(0, 8)
		: meta.involved.slice(0, 8);

	return (
		<>
			<header className="plan-decision-heading">
				<p>{question.prompt}</p>
				{actions ?? (owner && <Face handle={owner} ring="page" size={18} />)}
			</header>
			<ChosenList answer={answer} question={item} />
			{custom && <p className="plan-decision-custom">{custom}</p>}
			{at !== undefined && Number.isFinite(at) && (
				<p className="plan-decision-when">
					<ClockIcon aria-hidden="true" size={14} />
					{decidedOn(at)}
				</p>
			)}
			{full && owner && (
				<div className="plan-decision-people">
					<span aria-hidden="true" className="plan-decision-faces">
						{handles.map(handle => <Face handle={handle} ring="page" size={18} key={handle} />)}
					</span>
					<span>{discussionLine(owner, meta.involved)}</span>
				</div>
			)}
		</>
	);
}

export function DecisionDialogContent(
	{
		closeRef,
		confirming = false,
		editable,
		error,
		meta,
		onClose,
		onDiscard,
		onKeep,
		onReopen,
		onSource,
		pending,
		value,
	}: {
		closeRef?: Ref<HTMLButtonElement>;
		confirming?: boolean;
		editable: boolean;
		error?: string;
		meta: Question.CardMeta;
		onClose: () => void;
		onDiscard: () => void;
		onKeep: () => void;
		onReopen: () => void;
		onSource?: () => void;
		pending?: "discard" | "reopen";
		value: Questionnaire;
	},
) {
	return (
		<>
			<DecisionSummary
				actions={
					<span className="plan-decision-heading-actions">
						{meta.thread && onSource && (
							<button
								aria-label="Show source in chat"
								className="plan-decision-icon-button"
								onClick={onSource}
								type="button"
							>
								<MessageForwardIcon aria-hidden="true" size={14} />
							</button>
						)}
						<button
							aria-label="Close"
							className="plan-decision-icon-button"
							onClick={onClose}
							ref={closeRef}
							type="button"
						>
							<CloseIcon aria-hidden="true" size={14} />
						</button>
					</span>
				}
				full
				meta={meta}
				value={value}
			/>
			{error && <p className="plan-decision-error" role="alert">{error}</p>}
			{pending && (
				<p className="plan-decision-pending" role="status">
					{pending === "discard" ? "Discarding…" : "Reopening…"}
				</p>
			)}
			<footer className="plan-decision-actions">
				{confirming
					? (
						<>
							<span>Discard this decision?</span>
							<button className="btn btn-sm btn-secondary" onClick={onKeep} type="button">
								Keep it
							</button>
							<button
								className="btn btn-sm btn-destructive"
								disabled={!editable || !!pending}
								onClick={onDiscard}
								type="button"
							>
								Discard decision
							</button>
						</>
					)
					: (
						<>
							<button
								className="btn btn-sm btn-secondary"
								disabled={!editable || !!pending}
								onClick={onDiscard}
								type="button"
							>
								Discard
							</button>
							<button
								className="btn btn-sm btn-primary"
								disabled={!editable || !!pending}
								onClick={onReopen}
								type="button"
							>
								Reopen
							</button>
						</>
					)}
			</footer>
		</>
	);
}
