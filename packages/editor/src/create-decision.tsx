import { useEffect, useId, useRef, useState } from "react";
import { DecisionIcon } from "@chopin/icons";
import { limits } from "@chopin/question";
import { SidecarCard } from "./card";
import type { Transport } from "@chopin/question/react";
import type { Question } from "@chopin/protocol";

export function CreateDecision(
	{ disabled, onCancel, onCreated, wire }: {
		disabled: boolean;
		onCancel: () => void;
		onCreated: (id: string) => void;
		wire: Transport | undefined;
	},
) {
	let base = useId();
	let [question, setQuestion] = useState("");
	let [description, setDescription] = useState("");
	let [pending, setPending] = useState(false);
	let [error, setError] = useState<string>();
	let key = useRef<string>(undefined);
	let field = useRef<HTMLInputElement>(null);
	let active = useRef(true);
	let currentWire = useRef(wire);
	currentWire.current = wire;
	let submitting = useRef(false);
	useEffect(() => {
		active.current = true;
		field.current?.focus();
		return () => {
			active.current = false;
		};
	}, []);
	let changed = () => {
		key.current = undefined;
		setError(undefined);
	};
	let create = async () => {
		if (!wire || disabled || submitting.current || !question.trim()) return;
		submitting.current = true;
		setPending(true);
		setError(undefined);
		key.current ??= crypto.randomUUID();
		try {
			let reply = await wire.ask("question:create", {
				key: key.current,
				question: question.trim(),
				...(description.trim() ? { description: description.trim() } : {}),
			}) as Question.Create.Reply;
			if (!active.current || currentWire.current !== wire) return;
			if (reply.ok) onCreated(reply.id);
			else setError(reply.message);
		} catch {
			if (active.current && currentWire.current === wire) {
				setError("Could not create this decision. Try again.");
			}
		} finally {
			submitting.current = false;
			if (active.current) setPending(false);
		}
	};
	return (
		<SidecarCard className="decision-create" label="New decision" padded={false}>
			<form
				aria-busy={pending}
				className="question-card"
				onSubmit={event => {
					event.preventDefault();
					void create();
				}}
			>
				<header className="question-head">
					<span aria-hidden="true" className="question-mark">
						<DecisionIcon />
					</span>
					<div className="question-head-text">
						<h3 className="question-title">New decision</h3>
					</div>
				</header>
				<div className="question-written decision-create-fields">
					<label className="sr-only" htmlFor={`${base}-question`}>Decision question</label>
					<input
						className="question-written-field"
						disabled={disabled || pending}
						id={`${base}-question`}
						maxLength={limits.MAX_NEW_QUESTION}
						onChange={event => {
							changed();
							setQuestion(event.currentTarget.value);
						}}
						placeholder="How should onboarding work?"
						ref={field}
						required
						value={question}
					/>
					<label className="question-hint" htmlFor={`${base}-context`}>Context (optional)</label>
					<textarea
						className="question-field question-written-field decision-create-context"
						disabled={disabled || pending}
						id={`${base}-context`}
						maxLength={limits.MAX_QUESTION_DESCRIPTION}
						onChange={event => {
							changed();
							setDescription(event.currentTarget.value);
						}}
						rows={2}
						value={description}
					/>
					{error && <p className="m-0 text-sm text-danger-text" role="alert">{error}</p>}
				</div>
				<footer className="question-actions">
					<button
						className="btn btn-sm btn-outline"
						disabled={pending}
						onClick={onCancel}
						type="button"
					>
						Cancel
					</button>
					<button
						className="btn btn-sm btn-primary"
						disabled={disabled || pending || !question.trim()}
						type="submit"
					>
						{pending ? "Creating…" : "Create decision"}
					</button>
				</footer>
			</form>
		</SidecarCard>
	);
}
