import { useId } from "react";
import { MAX_CUSTOM } from "../limits";
import { InlineCode } from "./inline-code";
import type { Item } from "../schema";

export function TextAnswer(
	{ disabled, value, onChange }: {
		disabled: boolean;
		value: string;
		onChange: (value: string) => void;
	},
) {
	let hint = useId();
	return (
		<div className="question-written">
			<label className="sr-only" htmlFor={`${hint}-answer`}>Working answer</label>
			<textarea
				aria-describedby={hint}
				className="question-field question-written-field"
				disabled={disabled}
				id={`${hint}-answer`}
				maxLength={MAX_CUSTOM}
				onChange={event => onChange(event.currentTarget.value)}
				placeholder="Write the decision and why"
				rows={4}
				value={value}
			/>
			<p className="question-hint" id={hint}>Shared draft until someone records it</p>
		</div>
	);
}

export function CandidateApproaches({ question }: { question: Item }) {
	return question.options.map((option, index) => (
		<div className="question-choice-row question-option" key={option.id}>
			<span aria-hidden="true" className="question-key">
				<span>{String.fromCharCode(65 + index)}</span>
			</span>
			<span className="question-text">
				<span className="question-label">
					<InlineCode text={option.label} />
				</span>
				{option.description && (
					<span className="question-desc">
						<InlineCode text={option.description} />
					</span>
				)}
			</span>
		</div>
	));
}
