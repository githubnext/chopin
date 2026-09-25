import {
	contrast,
	formatRatio,
	formatThreshold,
	passes,
	PURPOSE_LABELS,
	PURPOSES,
	toHex,
} from "@chopin/color";
import { CheckIcon, WarningIcon } from "@chopin/icons";
import { useEffect, useId, useRef, useState } from "react";

import { IconLabel } from "../icon-label";

import type { Oklch, Purpose } from "@chopin/color";

export type ContrastOption = { id: string; label: string; value: Oklch };

export type ContrastReaderProps = {
	value: Oklch;
	previous?: Oklch;
	against: string;
	options: readonly ContrastOption[];
	onAgainstChange(id: string): void;
	purpose: Purpose;
	onPurposeChange(purpose: Purpose): void;
};

export function ContrastReader({
	value,
	previous,
	against,
	options,
	onAgainstChange,
	purpose,
	onPurposeChange,
}: ContrastReaderProps) {
	let id = useId();
	let purposePrefix = `${id}-purpose-`;
	let againstPrefix = `${id}-against-`;
	let background = options.find(option => option.id === against) ?? options[0];
	let ratio = background ? contrast(value, background.value) : null;
	let pass = ratio !== null && passes(ratio, purpose);
	let threshold = formatThreshold(purpose);
	let was = previous && background ? formatRatio(contrast(previous, background.value)) : null;
	let shown = ratio === null ? "—" : formatRatio(ratio);
	let message = ratio === null ? "" : `Contrast ${shown}, ${pass ? "meets" : "below"} ${threshold}`;

	let [announcement, setAnnouncement] = useState("");
	let lastMessage = useRef<string | null>(null);
	useEffect(() => {
		if (lastMessage.current === null) {
			lastMessage.current = message;
			return;
		}
		if (message === lastMessage.current) return;
		lastMessage.current = message;
		// Delay announcements until a drag or sequence of choices settles.
		let timer = setTimeout(() => setAnnouncement(message), 500);
		return () => clearTimeout(timer);
	}, [message]);

	return (
		<section aria-label="Contrast" className="cv-contrast">
			<div className="cv-contrast-reading">
				<strong className="cv-contrast-ratio">{shown}</strong>
				{ratio !== null && (
					<IconLabel
						icon={pass ? CheckIcon : WarningIcon}
						label={`${pass ? "Meets" : "Below"} ${threshold}`}
						tone={pass ? "success" : "danger"}
					/>
				)}
			</div>
			{was && was !== shown && <p className="cv-contrast-was">was {was}</p>}
			<div className="cv-contrast-controls">
				<label className="cv-contrast-control">
					<span>Purpose</span>
					<select
						onChange={event =>
							onPurposeChange(event.target.value.slice(purposePrefix.length) as Purpose)}
						value={`${purposePrefix}${purpose}`}
					>
						{PURPOSES.map(item => (
							<option key={item} value={`${purposePrefix}${item}`}>
								{PURPOSE_LABELS[item]} · {formatThreshold(item)}
							</option>
						))}
					</select>
				</label>
				{background && (
					<label className="cv-contrast-control">
						<span>Against</span>
						<span className="cv-contrast-against">
							<span
								aria-hidden="true"
								className="cv-contrast-swatch"
								style={{ background: toHex(background.value) }}
							/>
							<select
								onChange={event => onAgainstChange(event.target.value.slice(againstPrefix.length))}
								value={`${againstPrefix}${background.id}`}
							>
								{options.map(option => (
									<option key={option.id} value={`${againstPrefix}${option.id}`}>
										{option.label}
									</option>
								))}
							</select>
						</span>
					</label>
				)}
			</div>
			<span aria-live="polite" className="cv-visually-hidden">{announcement}</span>
		</section>
	);
}
