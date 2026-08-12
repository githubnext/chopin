import type { Point, Rect } from "./comment-geometry";

/** A client range rectangle expressed inside the document overlay. */
export type PassageHit = Point & { width: number; height: number };

/**
 * Keep every line a passage occupies interactive without putting a span into
 * the collaborative document. A range returns one rectangle per wrapped line;
 * clipping them to the document keeps the overlay honest during scroll and
 * resize races.
 */
export function passageHits(host: Rect, clientRects: Iterable<Rect>): PassageHit[] {
	let hits: PassageHit[] = [];
	for (let client of clientRects) {
		let left = Math.max(client.left, host.left);
		let right = Math.min(client.right, host.right);
		let top = Math.max(client.top, host.top);
		let bottom = Math.min(client.bottom, host.bottom);
		if (right <= left || bottom <= top) continue;
		hits.push({
			top: top - host.top,
			left: left - host.left,
			width: right - left,
			height: bottom - top,
		});
	}
	return hits;
}

/** Whether a host-relative pointer sits over one exact passage line. */
export function containsHit(hits: PassageHit[], point: Point): boolean {
	return hits.some(hit =>
		point.top >= hit.top
		&& point.top <= hit.top + hit.height
		&& point.left >= hit.left
		&& point.left <= hit.left + hit.width
	);
}
