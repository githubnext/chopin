/**
 * Which card of a deck is on top, and where the rest sit.
 *
 * Order is one reader's working position, not a fact about the document, so it
 * lives here and in React state and never reaches a record or a collaborator.
 */

export type DeckEntry = { id: string; settled: boolean };

/** How many cards behind the top show an edge. */
export const PEEKS = 4;
/** How far each place sits above the top card's edge, in rem: 14, 10, 7 then 5px more. */
const LIFTS = [0, 0.875, 1.5, 1.9375, 2.25];
const SCALES = [1, 0.97, 0.945, 0.925, 0.91];

/** How far the deepest card shown sits above the top card, for a deck of `count`. */
export function lift(count: number): string {
	return `${LIFTS[Math.max(0, Math.min(count - 1, PEEKS))]}rem`;
}

/** Reconcile a reader's order with the current members, moving nothing that survived. */
export function arrange(previous: readonly string[], items: readonly DeckEntry[]): string[] {
	let present = new Map(items.map(item => [item.id, item]));
	let kept = previous.filter(id => present.has(id));
	let known = new Set(kept);
	for (let item of items) {
		if (known.has(item.id)) continue;
		known.add(item.id);
		if (item.settled) {
			kept.push(item.id);
			continue;
		}
		let back = kept.findIndex(id => present.get(id)!.settled);
		if (back === -1) kept.push(item.id);
		else kept.splice(back, 0, item.id);
	}
	return kept;
}

/** Open cards in front, settled cards behind, each group in its current order. */
export function settle(order: readonly string[], items: readonly DeckEntry[]): string[] {
	let settled = new Set(items.filter(item => item.settled).map(item => item.id));
	return [...order.filter(id => !settled.has(id)), ...order.filter(id => settled.has(id))];
}

/**
 * One step through the deck in its counted order, or undefined past either end.
 * The cards behind the new top are the ones that follow it, so the next card is
 * always the nearest edge.
 */
export function step(
	order: readonly string[],
	items: readonly DeckEntry[],
	direction: 1 | -1,
): string[] | undefined {
	let counted = settle(items.map(item => item.id), items);
	let at = counted.indexOf(order[0] ?? "");
	let target = at + direction;
	if (at === -1 || target < 0 || target >= counted.length) return undefined;
	return [...counted.slice(target), ...counted.slice(0, target)];
}

export function bringForward(order: readonly string[], id: string): string[] {
	if (!order.includes(id)) return [...order];
	return [id, ...order.filter(other => other !== id)];
}

/** A card's place in the resting stack: open cards in document order, then settled ones. */
export function position(items: readonly DeckEntry[], id: string | undefined): number {
	if (id === undefined) return 0;
	return settle(items.map(item => item.id), items).indexOf(id) + 1;
}

export function slot(depth: number): { transform: string; zIndex: number; opacity: number } {
	let shown = Math.min(depth, PEEKS);
	return {
		transform: `translateY(${-LIFTS[shown]!}rem) scale(${SCALES[shown]})`,
		zIndex: 100 - depth,
		opacity: depth > PEEKS ? 0 : 1,
	};
}

/**
 * The card that changes places with the top: on next the old top leaves for the
 * back, on previous the new top arrives from in front. A settle sends back the
 * first card that fell.
 */
export function movingCard(
	previous: readonly string[],
	next: readonly string[],
	direction?: 1 | -1,
): { id: string; direction: "back" | "front" } | undefined {
	if (direction === 1 && previous[0] !== undefined) return { id: previous[0], direction: "back" };
	if (direction === -1 && next[0] !== undefined) return { id: next[0], direction: "front" };
	let id = previous.find((id, at) => next.indexOf(id) > at);
	return id === undefined ? undefined : { id, direction: "back" };
}

/**
 * Where a card leaves to and arrives from: off to the left, the side previous
 * cards are on, so next and previous read as a stack being paged through.
 */
export const AWAY = "translateX(-40%) scale(0.98)";

/**
 * The old top card slides aside and fades in front of the deck, then reappears
 * at its new place behind. Its content stays visible until it has faded, so the
 * cover only drops over it once it is out of sight.
 */
export function leaveFrames(
	from: { transform: string; opacity: number },
	to: string,
	total: number,
	hidden: boolean,
	easing?: string,
): { card: Keyframe[]; cover: Keyframe[] } {
	let eased = easing === undefined ? {} : { easing };
	let over = 101 + total;
	return {
		card: [
			// Linear out, so its content hands over evenly to the card arriving beneath.
			{ offset: 0, transform: from.transform, opacity: from.opacity, zIndex: over },
			{ offset: 0.5, transform: AWAY, opacity: 0, zIndex: over },
			{ offset: 0.5, transform: to, opacity: 0, zIndex: 0, ...eased },
			{ offset: 1, transform: to, opacity: hidden ? 0 : 1, zIndex: 0 },
		],
		cover: [
			{ offset: 0, opacity: 0 },
			{ offset: 0.5, opacity: 0 },
			{ offset: 0.5, opacity: 1 },
			{ offset: 1, opacity: 1 },
		],
	};
}

/**
 * A card coming back to the top slides in from where a leaving card goes, over
 * the deck. A card caught mid-move continues from where it is.
 */
export function arriveFrames(
	to: string,
	total: number,
	start?: { transform: string; opacity: number },
): Keyframe[] {
	let over = 101 + total;
	return [
		{
			transform: start?.transform ?? AWAY,
			opacity: start?.opacity ?? 0,
			zIndex: over,
		},
		{ transform: to, opacity: 1, zIndex: over },
	];
}
