import { format, parse, sameColor, toSrgb } from "@chopin/color";
import { useId, useState } from "react";

import type { ColorFormat, Oklch } from "@chopin/color";

export type ColorFieldProps = {
	value: Oklch;
	onChange(value: Oklch): void;
	format: ColorFormat;
	onFormatChange(format: ColorFormat): void;
};

// Re-parsing an unchanged hex value would replace its higher-precision OKLCH source.
export function commitText(
	text: string,
	shown: string,
	value: Oklch,
): { value: Oklch | null; invalid: boolean } {
	if (text.trim() === shown) return { value: null, invalid: false };
	let parsed = parse(text);
	if (!parsed) return { value: null, invalid: true };
	return { value: sameColor(parsed, value) ? null : parsed, invalid: false };
}

export function ColorField({ value, onChange, format: form, onFormatChange }: ColorFieldProps) {
	let id = useId();
	let shown = format(value, form);
	let [draft, setDraft] = useState<{ text: string; shown: string } | null>(null);
	let [invalid, setInvalid] = useState(false);

	function commit() {
		if (!draft) return;
		let result = commitText(draft.text, draft.shown, value);
		setInvalid(result.invalid);
		if (result.invalid) return;
		setDraft(null);
		if (result.value) onChange(result.value);
	}

	return (
		<div className="cv-color-field">
			<div className="cv-color-field-row">
				<select
					aria-label="Color format"
					onChange={event => onFormatChange(event.target.value.slice(id.length + 1) as ColorFormat)}
					value={`${id}-${form}`}
				>
					<option value={`${id}-oklch`}>OKLCH</option>
					<option value={`${id}-hex`}>HEX</option>
				</select>
				<input
					aria-invalid={invalid || undefined}
					aria-label="Color value"
					onBlur={commit}
					onChange={event => {
						setDraft({ text: event.target.value, shown: draft?.shown ?? shown });
						setInvalid(false);
					}}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
						if (event.key === "Escape") {
							event.stopPropagation();
							setDraft(null);
							setInvalid(false);
						}
					}}
					spellCheck={false}
					value={draft?.text ?? shown}
				/>
			</div>
			{!toSrgb(value).inGamut && <p className="cv-color-field-note">Outside sRGB, shown clipped</p>}
		</div>
	);
}
