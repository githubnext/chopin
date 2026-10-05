export type Rect = {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
};

export type Point = { top: number; left: number };
/** An offscreen marker follows its passage outside the document and is not shown. */
export type MarkerPoint = Point & { offscreen?: true };
export type MarkerTarget = { target: Rect; passages: Rect[] };

/** A decision marker sits before the first line of its decided paragraph. */
export function marginPoint(target: Rect, host: Rect, size = 24, gap = 8): Point {
	return {
		top: clamp(target.top - host.top, 0, host.height - size),
		left: clamp(target.left - host.left - size - gap, 0, host.width - size),
	};
}

/** A decision preview and its pinned popover share a position beneath the prose. */
export function decisionPanelPoint(
	target: Rect,
	host: Rect,
	width: number,
	height: number,
	gap = 6,
): Point {
	let below = target.bottom - host.top + gap;
	let above = target.top - host.top - height - gap;
	return {
		top: below + height <= host.height
			? below
			: above >= 0
			? above
			: clamp(below, 0, host.height - height),
		left: clamp(target.left - host.left, 0, host.width - width),
	};
}

export function markerRect(point: Point, host: Rect, size: number): Rect {
	return {
		top: host.top + point.top,
		right: host.left + point.left + size,
		bottom: host.top + point.top + size,
		left: host.left + point.left,
		width: size,
		height: size,
	};
}

/** Place every comment marker against all prose before considering earlier markers. */
export function markerPoints(
	targets: MarkerTarget[],
	host: Rect,
	size = 24,
	gap = 8,
): MarkerPoint[] {
	let passages = targets.flatMap(({ passages, target }) =>
		passages.length > 0 ? passages : [target]
	);
	let markers: Rect[] = [];
	return targets.map(({ target }) => {
		if (target.bottom <= host.top || target.top >= host.bottom) {
			return {
				top: target.top - host.top,
				left: clamp(target.right - host.left + gap, 0, host.width - size),
				offscreen: true,
			};
		}
		let point = markerPoint(target, host, passages, markers, size, gap);
		markers.push(markerRect(point, host, size));
		return point;
	});
}

function markerPoint(
	target: Rect,
	host: Rect,
	passages: Rect[],
	markers: Rect[],
	size = 24,
	gap = 8,
): Point {
	let maxLeft = host.width - size;
	let maxTop = host.height - size;
	let ideal = {
		top: clamp(target.top - host.top, 0, Math.max(0, maxTop)),
		left: clamp(target.right - host.left + gap, 0, Math.max(0, maxLeft)),
	};
	let obstacles = [...passages, ...markers];
	if (maxLeft >= 0 && maxTop >= 0) {
		let lefts = unique([
			ideal.left,
			target.left - host.left - size - gap,
			...obstacles.flatMap(obstacle => [
				obstacle.right - host.left + gap,
				obstacle.left - host.left - size - gap,
			]),
			0,
			maxLeft,
		])
			.filter(left => left >= 0 && left <= maxLeft)
			.sort((a, b) => Math.abs(a - ideal.left) - Math.abs(b - ideal.left) || a - b);
		let tops = unique([
			ideal.top,
			...obstacles.flatMap(obstacle => [
				obstacle.bottom - host.top + gap,
				obstacle.top - host.top - size - gap,
			]),
			0,
			maxTop,
		])
			.filter(top => top >= 0 && top <= maxTop)
			.sort((a, b) => Math.abs(a - ideal.top) - Math.abs(b - ideal.top) || a - b);

		for (let left of lefts) {
			for (let top of tops) {
				let candidate = {
					top: host.top + top,
					right: host.left + left + size,
					bottom: host.top + top + size,
					left: host.left + left,
					width: size,
					height: size,
				};
				if (obstacles.every(obstacle => !intersects(candidate, obstacle))) {
					return { top, left };
				}
			}
		}
	}

	// An off-viewport marker remains an affordance and cannot obscure prose.
	return {
		top: Math.max(target.bottom, ...obstacles.map(obstacle => obstacle.bottom)) - host.top + gap,
		left: ideal.left,
	};
}

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

/** Keep an engaged comment in one predictable document-edge surface. */
export function edgePanelPoint(
	anchor: Rect,
	host: Rect,
	width: number,
	height: number,
	inset = 12,
): Point {
	return {
		top: clamp(anchor.top - host.top, inset, host.height - height - inset),
		left: Math.max(inset, host.width - width - inset),
	};
}

function clamp(value: number, lower: number, upper: number): number {
	return Math.min(Math.max(value, lower), Math.max(lower, upper));
}

function intersects(a: Rect, b: Rect): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function unique(values: number[]): number[] {
	return [...new Set(values)];
}
