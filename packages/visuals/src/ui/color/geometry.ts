import { maxChroma, normalizeHue, toHex, toSrgb } from "@chopin/color";

import type { Oklch } from "@chopin/color";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Modifiers = { shiftKey?: boolean; altKey?: boolean };
export type GridPosition = { row: number; index: number };
export type Box = { left: number; top: number; width: number; height: number };

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): string {
	return String(Number(value.toFixed(2)));
}

/*
 * Chroma runs on a square-root axis. Linear, a C≈0.01 neutral sits in the first few percent
 * of a plane whose range is the hue's cusp (≈0.18), which makes grays undraggable.
 */
export function planeValue(point: Point, size: Size, hue: number, range: number): Oklch {
	let l = clamp(1 - point.y / size.height, 0, 1);
	let fraction = clamp(point.x / size.width, 0, 1);
	return { l, c: Math.min(fraction ** 2 * range, maxChroma(l, hue)), h: hue };
}

export function planePosition(value: Oklch, size: Size, range: number): Point {
	return {
		x: Math.sqrt(clamp(value.c / range, 0, 1)) * size.width,
		y: (1 - clamp(value.l, 0, 1)) * size.height,
	};
}

export function planeImage(hue: number, range: number, resolution = 96): Uint8ClampedArray {
	let pixels = new Uint8ClampedArray(resolution * resolution * 4);
	for (let y = 0; y < resolution; y++) {
		let l = 1 - (y + 0.5) / resolution;
		for (let x = 0; x < resolution; x++) {
			let rgb = toSrgb({ l, c: ((x + 0.5) / resolution) ** 2 * range, h: hue });
			let offset = (y * resolution + x) * 4;
			pixels[offset] = rgb.r;
			pixels[offset + 1] = rgb.g;
			pixels[offset + 2] = rgb.b;
			pixels[offset + 3] = rgb.inGamut ? 255 : 0;
		}
	}
	return pixels;
}

export function gamutPath(hue: number, range: number, size: Size, samples = 64): string {
	let commands: string[] = [];
	for (let index = 0; index <= samples; index++) {
		let l = 1 - index / samples;
		let point = planePosition({ l, c: maxChroma(l, hue), h: hue }, size, range);
		commands.push(`${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`);
	}
	return commands.join(" ");
}

function scale(modifiers: Modifiers): number {
	return modifiers.shiftKey ? 10 : modifiers.altKey ? 0.1 : 1;
}

export function planeKey(value: Oklch, key: string, modifiers: Modifiers): Oklch | null {
	let factor = scale(modifiers);
	let { l, c } = value;
	if (key === "ArrowLeft") c -= 0.001 * factor;
	else if (key === "ArrowRight") c += 0.001 * factor;
	else if (key === "ArrowUp") l += 0.01 * factor;
	else if (key === "ArrowDown") l -= 0.01 * factor;
	else if (key === "PageUp") l += 0.1;
	else if (key === "PageDown") l -= 0.1;
	else return null;
	l = clamp(l, 0, 1);
	return { l, c: clamp(c, 0, maxChroma(l, value.h)), h: value.h };
}

export function hueValue(y: number, height: number): number {
	return clamp(1 - y / height, 0, 1) * 360;
}

export function huePosition(h: number, height: number): number {
	if (h === 360) return 0;
	return (1 - normalizeHue(h) / 360) * height;
}

export function hueKey(h: number, key: string, modifiers: Modifiers): number | null {
	let step = modifiers.shiftKey ? 10 : 1;
	if (key === "ArrowUp" || key === "ArrowRight") return normalizeHue(h + step);
	if (key === "ArrowDown" || key === "ArrowLeft") return normalizeHue(h - step);
	return null;
}

export function hueGradient(): string {
	let stops: string[] = [];
	for (let h = 0; h <= 360; h += 15) {
		stops.push(toHex({ l: 0.75, c: Math.min(0.15, maxChroma(0.75, h)), h }));
	}
	return `linear-gradient(to top, ${stops.join(", ")})`;
}

function project(index: number, from: number, to: number): number {
	if (from <= 1 || to <= 1) return 0;
	return Math.round((index / (from - 1)) * (to - 1));
}

export function gridMove(
	lengths: readonly number[],
	at: GridPosition,
	key: string,
): GridPosition | null {
	let length = lengths[at.row];
	if (!length) return null;
	if (key === "ArrowRight") return { row: at.row, index: Math.min(at.index + 1, length - 1) };
	if (key === "ArrowLeft") return { row: at.row, index: Math.max(at.index - 1, 0) };
	if (key === "Home") return { row: at.row, index: 0 };
	if (key === "End") return { row: at.row, index: length - 1 };
	if (key !== "ArrowDown" && key !== "ArrowUp") return null;
	let direction = key === "ArrowDown" ? 1 : -1;
	for (let row = at.row + direction; row >= 0 && row < lengths.length; row += direction) {
		if (lengths[row] > 0) return { row, index: project(at.index, length, lengths[row]) };
	}
	return at;
}

export function placePopover(
	anchor: Box,
	size: Size,
	viewport: Box,
	margin = 16,
	gap = 8,
): { left: number; top: number; side: "below" | "above" } {
	let top = viewport.top + margin;
	let bottom = viewport.top + viewport.height - margin;
	let below = anchor.top + anchor.height + gap;
	let above = anchor.top - gap - size.height;
	let roomBelow = bottom - below;
	let roomAbove = anchor.top - gap - top;
	let side: "below" | "above" = roomBelow >= size.height
		? "below"
		: roomAbove >= size.height || roomAbove > roomBelow
		? "above"
		: "below";
	let maximum = Math.max(
		viewport.left + margin,
		viewport.left + viewport.width - margin - size.width,
	);
	let left = clamp(
		anchor.left + anchor.width / 2 - size.width / 2,
		viewport.left + margin,
		maximum,
	);
	let maximumTop = Math.max(top, bottom - size.height);
	return { left, top: clamp(side === "below" ? below : above, top, maximumTop), side };
}
