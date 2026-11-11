/**
 * What a Tailwind class list means in pixels, for the properties the audit measures.
 *
 * Copied assistant-ui elements keep their own Tailwind classes, so their sizes are the pixel values
 * those classes mean in Tailwind v4: a 4px spacing unit, its radii and its type steps. These are
 * written out here, not read from the app's theme, so a theme that drifts from Tailwind fails.
 */
const UNIT = 4;
const RADIUS: Record<string, number> = {
	none: 0,
	xs: 2,
	sm: 4,
	md: 6,
	lg: 8,
	xl: 12,
	"2xl": 16,
	"3xl": 24,
	"4xl": 32,
};
/** Tailwind v4's `text-*` steps: size and line height in px. */
const TEXT: Record<string, [number, number]> = {
	xs: [12, 16],
	sm: [14, 20],
	base: [16, 24],
	lg: [18, 28],
	xl: [20, 28],
	"2xl": [24, 32],
};

export type Sides = [top: number, right: number, bottom: number, left: number];
export type Geometry = {
	height?: number;
	width?: number;
	padding?: Partial<Record<0 | 1 | 2 | 3, number>>;
	border: Sides;
	radius: number;
	radii?: Sides;
	gap?: number;
	fontSize?: number;
	lineHeight?: number;
};

let step = (value: string): number | undefined =>
	value === "px" ? 1 : /^\d+(\.\d+)?$/.test(value) ? Number(value) * UNIT : undefined;

/** What a class list means, for the properties the audit measures. Variants and arbitrary values are not read. */
export function expected(className: string, tagName?: string): Geometry {
	let result: Geometry = { border: tagName === "hr" ? [1, 0, 0, 0] : [0, 0, 0, 0], radius: 0 };
	let classes = className.split(/\s+/).map(item => item.replace(/^!|!$/g, "")).filter(item =>
		item && !item.includes(":") && !item.includes("[&")
	);
	// Tailwind writes the shorthand before the side, so a side wins: p, px/py, ps/pe, then pt/pr/pb/pl.
	let padding: [string, (value: number) => [number, number, number, number]][] = [
		["p", value => [value, value, value, value]],
		["px", value => [-1, value, -1, value]],
		["py", value => [value, -1, value, -1]],
		["ps", value => [-1, -1, -1, value]],
		["pe", value => [-1, value, -1, -1]],
		["pt", value => [value, -1, -1, -1]],
		["pr", value => [-1, value, -1, -1]],
		["pb", value => [-1, -1, value, -1]],
		["pl", value => [-1, -1, -1, value]],
	];
	for (let [name, sides] of padding) {
		for (let item of classes) {
			let match = new RegExp(`^${name}-(.+)$`).exec(item);
			let value = match ? step(match[1]!) : undefined;
			if (value === undefined) continue;
			result.padding ??= {};
			sides(value).forEach((side, index) => {
				if (side >= 0) result.padding![index as 0 | 1 | 2 | 3] = side;
			});
		}
	}
	let corners: Sides = [0, 0, 0, 0];
	for (let item of classes) {
		let size = /^size-(.+)$/.exec(item)?.[1];
		let height = /^h-(.+)$/.exec(item)?.[1];
		let width = /^w-(.+)$/.exec(item)?.[1];
		if (size && step(size) !== undefined) result.height = result.width = step(size);
		if (height && step(height) !== undefined) result.height = step(height);
		// A minimum is the height of a box with less than that inside it, which is what the audit draws.
		let least = /^min-h-(.+)$/.exec(item)?.[1];
		if (least && step(least) !== undefined && !classes.some(other => /^(h|size)-/.test(other))) {
			result.height = step(least);
		}
		if (width && step(width) !== undefined) result.width = step(width);
		let gap = /^gap-(.+)$/.exec(item)?.[1];
		if (gap && step(gap) !== undefined) result.gap = step(gap);
		let rounded = /^rounded(?:-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-(.+))?$/.exec(item);
		if (rounded) {
			let place = rounded[1];
			let key = rounded[2] ?? "sm";
			let value = key === "full" ? Infinity : key in RADIUS ? RADIUS[key] : undefined;
			if (value !== undefined) {
				let target = !place
					? [0, 1, 2, 3]
					: place === "t"
					? [0, 1]
					: place === "r" || place === "e"
					? [1, 2]
					: place === "b"
					? [2, 3]
					: place === "l" || place === "s"
					? [0, 3]
					: place === "tl" || place === "ss"
					? [0]
					: place === "tr" || place === "se"
					? [1]
					: place === "br" || place === "ee"
					? [2]
					: [3];
				for (let index of target) corners[index as 0 | 1 | 2 | 3] = value;
			}
		}
		let border = /^border(?:-([trblxyse]))?(?:-(\d+))?$/.exec(item);
		if (border) {
			let width = border[2] === undefined ? 1 : Number(border[2]);
			let side = border[1];
			let on = (index: number) => {
				result.border[index as 0 | 1 | 2 | 3] = width;
			};
			if (!side) [0, 1, 2, 3].forEach(on);
			else if (side === "t") on(0);
			else if (side === "r" || side === "e") on(1);
			else if (side === "b") on(2);
			else if (side === "l" || side === "s") on(3);
			else if (side === "x") [1, 3].forEach(on);
			else [0, 2].forEach(on);
		}
		let text = /^text-(xs|sm|base|lg|xl|2xl)$/.exec(item)?.[1];
		if (text) [result.fontSize, result.lineHeight] = TEXT[text]!;
		let corner = /^rounded-\[(\d+(?:\.\d+)?)px\]$/.exec(item)?.[1];
		if (corner) corners = [Number(corner), Number(corner), Number(corner), Number(corner)];
		let literal = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(item)?.[1];
		if (literal) result.fontSize = Number(literal);
		if (classes.some(leading => leading.startsWith("leading-"))) delete result.lineHeight;
	}
	result.radius = corners[0];
	if (corners.some(corner => corner !== corners[0])) result.radii = corners;
	return result;
}
