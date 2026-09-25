/**
 * OKLCH ⇄ sRGB using Björn Ottosson's reference matrices.
 *
 * Everything downstream (hex, contrast, gamut) reads the clipped 8-bit result, because that
 * is what a screen shows and what a hex value in a stylesheet can express.
 */

export type Oklch = { l: number; c: number; h: number };
export type Srgb = { r: number; g: number; b: number; inGamut: boolean };
export type ColorFormat = "oklch" | "hex";

const ACHROMATIC = 1e-4;
const EQUAL = 1e-5;
const GAMUT = 1e-6;

export function normalizeHue(h: number): number {
	let value = h % 360;
	return value < 0 ? value + 360 : value + 0;
}

function linear({ l, c, h }: Oklch): [number, number, number] {
	let radians = h * Math.PI / 180;
	let a = c * Math.cos(radians);
	let b = c * Math.sin(radians);
	let long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];
}

function encode(value: number): number {
	return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decode(value: number): number {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function toSrgb(value: Oklch): Srgb {
	let channels = linear(value).map(encode);
	let inGamut = channels.every(channel => channel >= -GAMUT && channel <= 1 + GAMUT);
	let [r, g, b] = channels.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255));
	return { r, g, b, inGamut };
}

export function toHex(value: Oklch): string {
	let { r, g, b } = toSrgb(value);
	return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function fromBytes(r: number, g: number, b: number): Oklch {
	let [red, green, blue] = [r, g, b].map(channel => decode(channel / 255));
	let long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
	let medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
	let short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
	let l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
	let a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
	let bAxis = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
	let c = Math.hypot(a, bAxis);
	if (c < ACHROMATIC) return { l, c: 0, h: 0 };
	return { l, c, h: normalizeHue(Math.atan2(bAxis, a) * 180 / Math.PI) };
}

export function fromHex(text: string): Oklch | null {
	let match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
	if (!match) return null;
	let digits = match[1];
	if (digits.length === 3) digits = [...digits].map(digit => digit + digit).join("");
	return fromBytes(
		parseInt(digits.slice(0, 2), 16),
		parseInt(digits.slice(2, 4), 16),
		parseInt(digits.slice(4, 6), 16),
	);
}

const OKLCH = /^oklch\(\s*([^\s/,()]+)\s+([^\s/,()]+)\s+([^\s/,()]+)\s*\)$/i;
const NUMBER = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i;

function channel(token: string, percent: number | null, degrees: boolean): number | null {
	if (token.toLowerCase() === "none") return 0;
	let match = NUMBER.exec(token);
	if (!match) return null;
	let value = Number(match[1]);
	let unit = match[2]?.toLowerCase();
	if (unit === "%") return percent === null ? null : value / 100 * percent;
	if (unit === "deg" && !degrees) return null;
	return Number.isFinite(value) ? value : null;
}

export function parse(text: string): Oklch | null {
	let trimmed = text.trim();
	if (trimmed.startsWith("#")) return fromHex(trimmed);
	let match = OKLCH.exec(trimmed);
	if (!match) return null;
	let l = channel(match[1], 1, false);
	let c = channel(match[2], 0.4, false);
	let h = channel(match[3], null, true);
	if (l === null || c === null || h === null) return null;
	return { l: Math.min(1, Math.max(0, l)), c: Math.max(0, c), h: normalizeHue(h) };
}

function trim(value: number, digits: number): string {
	return String(Number(value.toFixed(digits)) + 0);
}

export function format(value: Oklch, form: ColorFormat): string {
	if (form === "hex") return toHex(value);
	let hue = Number(normalizeHue(value.h).toFixed(2)) % 360;
	return `oklch(${trim(value.l, 5)} ${trim(value.c, 5)} ${trim(hue, 2)})`;
}

export function sameColor(a: Oklch, b: Oklch): boolean {
	if (Math.abs(a.l - b.l) > EQUAL || Math.abs(a.c - b.c) > EQUAL) return false;
	if (a.c < ACHROMATIC && b.c < ACHROMATIC) return true;
	let delta = Math.abs(normalizeHue(a.h) - normalizeHue(b.h));
	return Math.min(delta, 360 - delta) <= EQUAL;
}
