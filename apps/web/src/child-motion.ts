/** Pure geometry for nested documents opening inside the root's document stack. */

export type Box = { left: number; top: number; width: number; height: number };
export type ChildMotionStyle = "lift" | "zoom";

export const CHILD_MOTION_STORAGE_KEY = "chopin:dev:child-motion";
/** Each covered card shrinks this much more than the one above it. */
const RECEDE_STEP = 0.03;

export function childMotionStyle(enabled: boolean, stored: string | null): ChildMotionStyle {
	return enabled && stored === "zoom" ? "zoom" : "lift";
}

function px(value: number): string {
	return `${Math.round(value * 100) / 100 || 0}px`;
}

function ratio(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function motionOrigin(opener: Box | undefined, panel: Box): Box {
	let right = panel.left + panel.width;
	let bottom = panel.top + panel.height;
	if (opener && opener.width > 0 && opener.height > 0) {
		let x = opener.left + opener.width / 2;
		let y = opener.top + opener.height / 2;
		if (x >= panel.left && x <= right && y >= panel.top && y <= bottom) {
			let left = Math.max(opener.left, panel.left);
			let top = Math.max(opener.top, panel.top);
			return {
				left,
				top,
				width: Math.min(opener.left + opener.width, right) - left,
				height: Math.min(opener.top + opener.height, bottom) - top,
			};
		}
	}
	return {
		left: panel.left + panel.width * 0.25,
		top: panel.top + panel.height * 0.8,
		width: panel.width * 0.5,
		height: panel.height * 0.2,
	};
}

export function clipInset(rect: Box, box: Box, radius: string): string {
	let top = Math.max(0, rect.top - box.top);
	let right = Math.max(0, box.left + box.width - rect.left - rect.width);
	let bottom = Math.max(0, box.top + box.height - rect.top - rect.height);
	let left = Math.max(0, rect.left - box.left);
	return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${radius})`;
}

export function rectTransform(from: Box, to: Box): string {
	return `translate(${px(from.left - to.left)}, ${px(from.top - to.top)}) scale(${
		ratio(from.width / to.width)
	}, ${ratio(from.height / to.height)})`;
}

/** A child layer drawn at the opener: uniform scale, clipped to the opener's aspect. */
export function zoomStart(origin: Box, box: Box, radius: string) {
	let scale = ratio(origin.width / box.width);
	return {
		transform: `translate(${px(origin.left - box.left)}, ${
			px(origin.top - box.top)
		}) scale(${scale})`,
		clipPath: `inset(0px 0px ${
			px(box.height - origin.height / scale)
		} 0px round calc(${radius} / ${scale}))`,
	};
}

/** Where `rect`, seen inside a parent at `scale` about `pivot`, lands at scale 1. */
export function settledBox(rect: Box, scale: number, pivot: { x: number; y: number }): Box {
	if (scale === 1) return rect;
	return {
		left: pivot.x + (rect.left - pivot.x) / scale,
		top: pivot.y + (rect.top - pivot.y) / scale,
		width: rect.width / scale,
		height: rect.height / scale,
	};
}

export function pileLayout(level: number, depth: number, rootBar: number, bar: number) {
	let behind = Math.max(0, depth - level);
	return {
		top: Math.min(level, 1) * rootBar + Math.max(level - 1, 0) * bar,
		scale: ratio(1 - behind * RECEDE_STEP),
	};
}
