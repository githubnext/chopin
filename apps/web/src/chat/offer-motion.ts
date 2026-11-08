/** Where a research offer card was last painted, and which message it followed there. */
export type OfferPlace = {
	/** The message the card followed. */
	at: string;
	/** Content-relative, so the reader's own scrolling is not motion. */
	top: number;
};

/**
 * The cards that follow a different message than where they were last painted. These are the only
 * ones that slide, and so the only ones worth measuring: a card with no recorded place has just
 * appeared and enters in place.
 */
export function movedOffers<Card extends { offer: string; placement: string }>(
	cards: readonly Card[],
	last: ReadonlyMap<string, OfferPlace>,
): Card[] {
	return cards.filter(card => {
		let before = last.get(card.offer);
		return before !== undefined && before.at !== card.placement;
	});
}

/**
 * How far a card that has just moved starts from its new place, so that it seems to slide from
 * where it was painted. `scrolled` is the scroll position it was painted at, `place` its new top
 * within the viewport. Less than a pixel is no motion.
 */
export function slideOffset(before: OfferPlace, scrolled: number, place: number): number {
	return before.top - scrolled - place;
}
