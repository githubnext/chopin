import { maxChroma, normalizeHue, toHex, toSrgb } from "@chopin/color";

import type { Oklch } from "@chopin/color";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Modifiers = { shiftKey?: boolean; altKey?: boolean };

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
