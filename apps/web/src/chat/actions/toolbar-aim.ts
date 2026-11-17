export type Point = { x: number; y: number };
export type Bar = { left: number; top: number; right: number; bottom: number };

export const AIM_TREMOR_PX = 2;
export const AIM_REST_MS = 300;

function distanceAcross(bar: Bar, point: Point): number {
	if (point.x < bar.left) return bar.left - point.x;
	if (point.x > bar.right) return point.x - bar.right;
	return 0;
}

function levelWithBar(bar: Bar, point: Point): boolean {
	return point.y >= bar.top && point.y <= bar.bottom + AIM_TREMOR_PX;
}

function noFartherAcross(bar: Bar, before: Point, after: Point): boolean {
	return distanceAcross(bar, after) <= distanceAcross(bar, before) + AIM_TREMOR_PX;
}

export function leavesTowardsBar(bar: Bar, lastInside: Point, leftAt: Point): boolean {
	return leftAt.y < lastInside.y && levelWithBar(bar, leftAt)
		&& noFartherAcross(bar, lastInside, leftAt);
}

export function keepsHeadingForBar(bar: Bar, previous: Point, next: Point): boolean {
	return levelWithBar(bar, next) && noFartherAcross(bar, previous, next);
}
