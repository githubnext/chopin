import { useRef, useState } from "react";

import { scrub } from "./geometry";

export type ScrubFieldProps = {
	label: string;
	ariaLabel: string;
	value: number;
	onChange(value: number): void;
	step: number;
	min: number;
	max: number;
	suffix?: string;
	precision?: number;
};

export function ScrubField({
	label,
	ariaLabel,
	value,
	onChange,
	step,
	min,
	max,
	suffix = "",
	precision = 0,
}: ScrubFieldProps) {
	let [draft, setDraft] = useState<string | null>(null);
	let drag = useRef<{ pointerId: number; x: number; value: number } | null>(null);
	let shown = `${value.toFixed(precision)}${suffix}`;

	function commit() {
		if (draft === null) return;
		let parsed = Number.parseFloat(draft);
		setDraft(null);
		if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
	}

	return (
		<div className="cv-scrub">
			<span
				aria-hidden="true"
				className="cv-scrub-handle"
				onPointerDown={event => {
					if (event.button !== 0) return;
					event.preventDefault();
					drag.current = { pointerId: event.pointerId, x: event.clientX, value };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={event => {
					if (!drag.current || event.pointerId !== drag.current.pointerId) return;
					onChange(scrub(drag.current.value, event.clientX - drag.current.x, { step, min, max }));
				}}
				onPointerUp={event => {
					if (!drag.current || event.pointerId !== drag.current.pointerId) return;
					drag.current = null;
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				onLostPointerCapture={() => {
					drag.current = null;
				}}
			>
				{label}
			</span>
			<input
				aria-label={ariaLabel}
				inputMode="decimal"
				onBlur={commit}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={event => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					} else if (event.key === "Escape" && draft !== null) {
						event.preventDefault();
						event.stopPropagation();
						setDraft(null);
					} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						let next = scrub(value, event.key === "ArrowUp" ? 4 : -4, {
							step: step * (event.shiftKey ? 10 : 1),
							min,
							max,
						});
						setDraft(null);
						onChange(next);
					}
				}}
				spellCheck={false}
				value={draft ?? shown}
			/>
		</div>
	);
}
