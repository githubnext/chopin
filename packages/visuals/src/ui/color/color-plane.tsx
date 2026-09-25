import { cusp, toHex } from "@chopin/color";
import { createElement, useEffect, useMemo, useRef } from "react";

import { gamutPath, planeImage, planeKey, planePosition, planeValue } from "./geometry";

import type { Oklch } from "@chopin/color";
import type { PointerEvent } from "react";

const RESOLUTION = 96;
const VIEW = { width: 100, height: 100 };

export type ColorPlaneProps = { value: Oklch; onChange(value: Oklch): void; label?: string };

export function ColorPlane({ value, onChange, label = "Lightness and chroma" }: ColorPlaneProps) {
	let canvas = useRef<HTMLCanvasElement>(null);
	let thumb = useRef<HTMLSpanElement>(null);
	let hue = value.h;
	let range = useMemo(() => cusp(hue), [hue]);
	let boundary = useMemo(() => gamutPath(hue, range, VIEW), [hue, range]);

	useEffect(() => {
		let context = canvas.current?.getContext("2d");
		if (!context) return;
		let image = context.createImageData(RESOLUTION, RESOLUTION);
		image.data.set(planeImage(hue, range, RESOLUTION));
		context.putImageData(image, 0, 0);
	}, [hue, range]);

	function pick(event: PointerEvent<HTMLDivElement>) {
		let rect = event.currentTarget.getBoundingClientRect();
		let point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		onChange(planeValue(point, rect, hue, range));
	}

	let position = planePosition(value, VIEW, range);
	return (
		<div
			className="cv-color-plane"
			onPointerDown={event => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				thumb.current?.focus({ preventScroll: true });
				pick(event);
			}}
			onPointerMove={event => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
			}}
		>
			<canvas aria-hidden="true" height={RESOLUTION} ref={canvas} width={RESOLUTION} />
			{createElement(
				"svg",
				{ "aria-hidden": true, preserveAspectRatio: "none", viewBox: "0 0 100 100" },
				createElement("path", { d: boundary }),
			)}
			<span
				aria-label={label}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={Math.round(value.l * 1000) / 10}
				aria-valuetext={`Lightness ${(value.l * 100).toFixed(1)}%, chroma ${
					Number(value.c.toFixed(4))
				}`}
				className="cv-color-plane-thumb"
				onKeyDown={event => {
					let next = planeKey(value, event.key, event);
					if (!next) return;
					event.preventDefault();
					onChange(next);
				}}
				ref={thumb}
				role="slider"
				style={{ left: `${position.x}%`, top: `${position.y}%`, background: toHex(value) }}
				tabIndex={0}
			/>
		</div>
	);
}
