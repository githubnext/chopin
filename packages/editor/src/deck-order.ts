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

export function position(items: readonly DeckEntry[], id: string | undefined): number {
	return id === undefined ? 0 : items.findIndex(item => item.id === id) + 1;
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
