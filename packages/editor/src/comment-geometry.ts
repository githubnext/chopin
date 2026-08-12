export type Rect = {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
};

export type Point = { top: number; left: number };

/** A comment button beside a passage, in the document host's coordinates. */
export function gutterPoint(target: Rect, host: Rect, size = 24, gap = 8): Point {
	return {
		top: clamp(target.top - host.top, 0, host.height - size),
		left: clamp(target.right - host.left + gap, 0, host.width - size),
	};
}

/** A pinned comment card beside its button, in the document host's coordinates. */
export function popoverPoint(
	button: Rect,
	host: Rect,
	width: number,
	height: number,
	gap = 8,
): Point {
	let right = button.right + gap + width <= host.right;
	return {
		top: clamp(button.top - host.top, 0, host.height - height),
		left: clamp(
			right ? button.right - host.left + gap : button.left - host.left - width - gap,
			0,
			host.width - width,
		),
	};
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}
