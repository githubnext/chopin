import { toHex } from "@chopin/color";
import { useRef } from "react";

import { hueGradient, hueKey, huePosition, hueValue } from "./geometry";

import type { Oklch } from "@chopin/color";
import type { PointerEvent } from "react";

const GRADIENT = hueGradient();

export type HueStripProps = { value: Oklch; onChange(h: number): void };

export function HueStrip({ value, onChange }: HueStripProps) {
	let thumb = useRef<HTMLSpanElement>(null);
	function pick(event: PointerEvent<HTMLDivElement>) {
		let rect = event.currentTarget.getBoundingClientRect();
		onChange(hueValue(event.clientY - rect.top, rect.height));
	}
	return (
		<div
			className="cv-hue-strip"
			onPointerDown={event => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				thumb.current?.focus({ preventScroll: true });
				pick(event);
			}}
			onPointerMove={event => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
			}}
			style={{ backgroundImage: GRADIENT }}
		>
			<span
				aria-label="Hue"
				aria-orientation="vertical"
				aria-valuemax={360}
				aria-valuemin={0}
				aria-valuenow={Math.round(value.h)}
				aria-valuetext={`${Math.round(value.h)}°`}
				className="cv-hue-strip-thumb"
				onKeyDown={event => {
					let next = hueKey(value.h, event.key, event);
					if (next === null) return;
					event.preventDefault();
					onChange(next);
				}}
				ref={thumb}
				role="slider"
				style={{ top: `${huePosition(value.h, 100)}%`, background: toHex(value) }}
				tabIndex={0}
			/>
		</div>
	);
}
