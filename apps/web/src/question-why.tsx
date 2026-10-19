/**
 * A settled decision's why: one plain sentence under the question. A writer edits it in place,
 * where Enter or leaving it saves and Escape puts the saved sentence back; everyone else reads it.
 */

import { useLayoutEffect, useRef, useState } from "react";

import type { Transport } from "@chopin/editor";
import type { Question } from "@chopin/protocol";

const MAX_WHY = 300;

function tidy(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_WHY);
}

export function QuestionWhy(
	{ canEdit, id, why, wire }: {
		canEdit: boolean;
		id: string;
		why: string | undefined;
		wire?: Transport;
	},
) {
	let field = useRef<HTMLDivElement>(null);
	let saved = useRef(why ?? "");
	let [error, setError] = useState<string>();
	let editable = canEdit && !!wire;

	// Another writer's change, or Chopin's draft arriving, replaces the line unless it is being edited.
	useLayoutEffect(() => {
		saved.current = why ?? "";
		let element = field.current;
		if (element && document.activeElement !== element) element.textContent = saved.current;
	}, [why]);

	if (!editable) {
		return why ? <p className="question-page-why">{why}</p> : null;
	}

	let save = async () => {
		let element = field.current;
		if (!element) return;
		let text = tidy(element.textContent ?? "");
		element.textContent = text;
		if (text === saved.current) return;
		let previous = saved.current;
		saved.current = text;
		setError(undefined);
		try {
			let reply = await wire!.ask<Question.Why.Reply>("question:why", { id, text });
			if (!reply.ok) throw new Error(reply.message);
		} catch (failure) {
			// A newer edit or an arriving draft owns the line now; only undo our own attempt.
			if (saved.current === text) {
				saved.current = previous;
				if (field.current && document.activeElement !== field.current) {
					field.current.textContent = previous;
				}
			}
			setError(failure instanceof Error ? failure.message : "Couldn’t save the reason");
		}
	};

	return (
		<>
			<div
				aria-label="Why"
				aria-multiline="false"
				className="question-page-why"
				contentEditable="plaintext-only"
				data-editable=""
				data-placeholder="Add a reason"
				onBlur={() => void save()}
				onInput={event => {
					// A emptied field can keep a stray line break, which would hide the placeholder.
					if (!event.currentTarget.textContent) event.currentTarget.replaceChildren();
				}}
				onKeyDown={event => {
					if (event.key === "Enter" && !event.nativeEvent.isComposing) {
						event.preventDefault();
						field.current?.blur();
					}
					if (event.key === "Escape") {
						if (field.current) field.current.textContent = saved.current;
						field.current?.blur();
					}
				}}
				ref={field}
				role="textbox"
				spellCheck
				suppressContentEditableWarning
				tabIndex={0}
			/>
			{error && <p className="question-page-why-error" role="alert">{error}</p>}
		</>
	);
}
