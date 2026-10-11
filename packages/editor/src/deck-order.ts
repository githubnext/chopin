/**
 * Which card of a deck is on top, and where the rest sit.
 *
 * Order is one reader's working position, not a fact about the document, so it
 * lives here and in React state and never reaches a record or a collaborator.
 */

export type DeckEntry = { id: string; settled: boolean };

/** How many cards behind the top show a header edge. */
export const PEEKS = 2;
const PEEK_REM = 1.875;
const SHRINK = 0.04;

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

export function cycle(order: readonly string[], direction: 1 | -1): string[] {
	if (order.length < 2) return [...order];
	return direction === 1
		? [...order.slice(1), order[0]!]
		: [order.at(-1)!, ...order.slice(0, -1)];
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
	let scale = Math.round((1 - shown * SHRINK) * 100) / 100;
	return {
		transform: `translateY(${-shown * PEEK_REM}rem) scale(${scale})`,
		zIndex: 100 - depth,
		opacity: depth > PEEKS ? 0 : 1,
	};
}

/**
 * The card that passes the others in a reorder. A cycle names its direction,
 * because in a deck of two the top and last cards swap either way.
 */
export function movingCard(
	previous: readonly string[],
	next: readonly string[],
	direction?: 1 | -1,
): { id: string; direction: "back" | "front" } | undefined {
	if (direction === 1 && previous[0] !== undefined) return { id: previous[0], direction: "back" };
	if (direction === -1 && previous.length > 0) return { id: previous.at(-1)!, direction: "front" };
	let id = previous.find((id, at) => next.indexOf(id) > at);
	return id === undefined ? undefined : { id, direction: "back" };
}

export const SHUFFLE_MIDPOINT = "translate(4%, 72%) rotate(2.5deg) scale(0.97)";

/**
 * Out past the deck's lower edge, under or over it at the midpoint, then into place.
 *
 * Pass `easing` here rather than to the whole animation: eased per half, the
 * layer swap lands at the midpoint in time instead of early in the gesture.
 * `start` is the layer and opacity of a card caught mid-shuffle, so reversing
 * it before the midpoint keeps it on the side of the deck it is already on.
 */
export function shuffleFrames(
	from: string,
	to: string,
	direction: "back" | "front",
	total: number,
	hidden: boolean,
	easing?: string,
	start?: { zIndex: number; opacity: number },
): Keyframe[] {
	// Above or below the `100 - depth` range, so the card passes every other one.
	let [before, after] = direction === "back" ? [101 + total, 0] : [0, 101 + total];
	let eased = easing === undefined ? {} : { easing };
	let layer = start?.zIndex ?? before;
	return [
		{ offset: 0, transform: from, zIndex: layer, opacity: start?.opacity ?? 1, ...eased },
		{ offset: 0.45, transform: SHUFFLE_MIDPOINT, zIndex: layer, opacity: 1 },
		{ offset: 0.45, transform: SHUFFLE_MIDPOINT, zIndex: after, opacity: 1, ...eased },
		{ offset: 1, transform: to, zIndex: after, opacity: hidden ? 0 : 1 },
	];
}
