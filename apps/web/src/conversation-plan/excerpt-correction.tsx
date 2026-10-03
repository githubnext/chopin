import { useLayoutEffect, useRef, useState } from "react";

import type { ConversationPlan } from "@chopin/protocol";
import type { ExcerptCorrectionAction } from "./analysis-action";

export function ExcerptCorrection(
	{ canEdit, linked, linkedSubspans, messageId, messageText, onAddExcerpt, outcome, quote, state }:
		{
			canEdit: boolean;
			linked: boolean;
			linkedSubspans: ConversationPlan.SourceRef[];
			messageId: string;
			messageText: string;
			onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
			outcome: ConversationPlan.CandidateOutcome;
			quote: string;
			state?: ConversationPlan.State;
		},
) {
	let [editing, setEditing] = useState(false);
	let contributionType = useRef<HTMLSelectElement>(null);
	let [kind, setKind] = useState<"option" | "reason" | "constraint">("reason");
	let [threadId, setThreadId] = useState("");
	let [targetOptionId, setTargetOptionId] = useState("");
	let [exactText, setExactText] = useState(quote);
	let [submitting, setSubmitting] = useState(false);
	let [error, setError] = useState("");
	let [success, setSuccess] = useState("");
	let action = useRef<{ key: string; id: string } | undefined>(undefined);
	let threads =
		state?.threads.filter(thread =>
			thread.questionnaireId && !["decided", "discarded"].includes(thread.status)
		) ?? [];
	let thread = threads.find(item => item.id === threadId);
	let options = thread?.contributions.filter(item => item.kind === "option") ?? [];
	let selectedText = exactText.trim();
	let sourceText = messageText.slice(outcome.start, outcome.end);
	let localStart = selectedText ? sourceText.indexOf(selectedText) : -1;
	let ambiguous = localStart >= 0 && sourceText.indexOf(selectedText, localStart + 1) >= 0;
	let start = localStart < 0 ? -1 : outcome.start + localStart;
	let end = start < 0 ? -1 : start + selectedText.length;
	let alreadyAdded = linkedSubspans.some(source => source.start === start && source.end === end);
	let validText = start >= outcome.start && end <= outcome.end && selectedText.length <= 500
		&& !ambiguous && !alreadyAdded;
	let validOption = !targetOptionId
		|| kind !== "option" && options.some(item => item.id === targetOptionId);
	let ready = canEdit && !!onAddExcerpt && !!thread && validText && validOption && !submitting;
	useLayoutEffect(() => {
		if (editing) contributionType.current?.focus();
	}, [editing]);
	let resetAction = () => {
		action.current = undefined;
		setError("");
		setSuccess("");
	};
	let submit = async () => {
		if (!ready || !thread || !onAddExcerpt) return;
		let key = JSON.stringify([
			thread.id,
			thread.version,
			messageId,
			start,
			end,
			kind,
			targetOptionId,
		]);
		let currentAction = action.current;
		if (!currentAction || currentAction.key !== key) {
			currentAction = { key, id: crypto.randomUUID() };
			action.current = currentAction;
		}
		setSubmitting(true);
		setError("");
		try {
			await onAddExcerpt({
				actionId: currentAction.id,
				threadId: thread.id,
				expectedVersion: thread.version,
				change: {
					kind: "add-excerpt",
					messageId,
					start,
					end,
					contributionKind: kind,
					...(targetOptionId && kind !== "option" ? { targetOptionId } : {}),
				},
			});
			setSuccess(`Added to ${thread.question} as a ${kind}.`);
			setEditing(false);
		} catch {
			setError("Could not add this excerpt. Check the card and connection, then try again.");
		} finally {
			setSubmitting(false);
		}
	};

	if (linked) {
		return (
			<p className="m-0 mt-1 text-sm text-success-ink" role="status">
				Added to this card.
			</p>
		);
	}
	if (!editing) {
		return (
			<>
				{(success || linkedSubspans.length > 0) && (
					<p className="m-0 mt-1 text-sm text-success-ink" role="status">
						{success
							|| `Added ${linkedSubspans.length} excerpt${
								linkedSubspans.length === 1 ? "" : "s"
							} to this card.`}
					</p>
				)}
				<button
					className="btn btn-sm btn-ghost mt-1"
					data-excerpt-correction-trigger
					disabled={!canEdit || !onAddExcerpt || threads.length === 0}
					onClick={() => setEditing(true)}
					type="button"
				>
					{success || linkedSubspans.length > 0 ? "Add another excerpt" : "Add to card"}
				</button>
			</>
		);
	}

	return (
		<div className="mt-2 grid gap-2 rounded-md bg-inset p-2">
			<label className="grid gap-1 text-sm font-medium text-text-secondary">
				Contribution type
				<select
					className="min-w-0 field px-2 py-1 text-sm font-normal"
					disabled={!canEdit || submitting}
					ref={contributionType}
					onChange={event => {
						let next = event.currentTarget.value as typeof kind;
						setKind(next);
						if (next === "option") setTargetOptionId("");
						resetAction();
					}}
					value={kind}
				>
					<option value="option">Option</option>
					<option value="reason">Reason</option>
					<option value="constraint">Constraint</option>
				</select>
			</label>
			<label className="grid gap-1 text-sm font-medium text-text-secondary">
				Decision card
				<select
					className="min-w-0 field px-2 py-1 text-sm font-normal"
					disabled={!canEdit || submitting}
					onChange={event => {
						setThreadId(event.currentTarget.value);
						setTargetOptionId("");
						resetAction();
					}}
					value={threadId}
				>
					<option value="">Choose a decision card</option>
					{threads.map(item => <option key={item.id} value={item.id}>{item.question}</option>)}
				</select>
			</label>
			{kind !== "option" && (
				<label className="grid gap-1 text-sm font-medium text-text-secondary">
					Related option
					<select
						className="min-w-0 field px-2 py-1 text-sm font-normal"
						disabled={!canEdit || submitting || !thread}
						onChange={event => {
							setTargetOptionId(event.currentTarget.value);
							resetAction();
						}}
						value={targetOptionId}
					>
						<option value="">Entire card</option>
						{options.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}
					</select>
				</label>
			)}
			<label className="grid gap-1 text-sm font-medium text-text-secondary">
				Exact text
				<textarea
					className="min-h-16 min-w-0 resize-y field px-2 py-1 text-sm font-normal"
					disabled={!canEdit || submitting}
					maxLength={500}
					onChange={event => {
						setExactText(event.currentTarget.value);
						resetAction();
					}}
					value={exactText}
				/>
			</label>
			{!validText && (
				<p className="m-0 text-sm text-text-tertiary">
					{alreadyAdded
						? "This exact text has already been added."
						: "Use exact text from this excerpt, up to 500 characters."}
				</p>
			)}
			{error && <p className="m-0 text-sm text-destructive-ink" role="alert">{error}</p>}
			<div className="flex justify-end gap-1">
				<button
					className="btn btn-sm btn-ghost"
					disabled={submitting}
					onClick={() => {
						setEditing(false);
						setError("");
					}}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-sm btn-primary"
					disabled={!ready}
					onClick={() => void submit()}
					type="button"
				>
					{submitting ? "Adding…" : "Add excerpt"}
				</button>
			</div>
		</div>
	);
}
