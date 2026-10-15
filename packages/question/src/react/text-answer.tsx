import { useId } from "react";
import { MAX_CUSTOM } from "../limits";

export function TextAnswer(
	{ disabled, value, onChange }: {
		disabled: boolean;
		value: string;
		onChange: (value: string) => void;
	},
) {
	let id = useId();
	return (
		<div className="question-written">
			<label className="sr-only" htmlFor={id}>Answer</label>
			<textarea
				className="question-field question-written-field"
				disabled={disabled}
				id={id}
				maxLength={MAX_CUSTOM}
				onChange={event => onChange(event.currentTarget.value)}
				placeholder="Write an answer…"
				rows={4}
				value={value}
			/>
		</div>
	);
}
