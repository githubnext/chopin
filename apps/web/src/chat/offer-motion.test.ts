import { describe, expect, it } from "bun:test";

import { movedOffers, slideOffset } from "./offer-motion";

import type { OfferPlace } from "./offer-motion";

let painted = new Map<string, OfferPlace>([
	["a", { at: "message-1", top: 400 }],
	["b", { at: "message-2", top: 900 }],
]);

describe("research offer motion", () => {
	it("measures only the cards that follow a different message than where they were painted", () => {
		let cards = [
			{ offer: "a", placement: "message-1" },
			{ offer: "b", placement: "message-5" },
		];

		expect(movedOffers(cards, painted)).toEqual([{ offer: "b", placement: "message-5" }]);
	});

	it("leaves every card alone when none of them has moved", () => {
		let cards = [
			{ offer: "a", placement: "message-1" },
			{ offer: "b", placement: "message-2" },
		];

		expect(movedOffers(cards, painted)).toEqual([]);
	});

	it("lets a card with no recorded place enter where it stands", () => {
		expect(movedOffers([{ offer: "new", placement: "message-9" }], painted)).toEqual([]);
		expect(movedOffers([{ offer: "new", placement: "message-9" }], new Map())).toEqual([]);
	});

	it("starts a slide where the card was last seen, whatever the reader scrolled since", () => {
		// Painted at 900 in content, the reader looking from 300: 600 down the viewport.
		// It now sits at 150 down the viewport, so it starts 450 below its place.
		expect(slideOffset({ at: "message-2", top: 900 }, 300, 150)).toBe(450);
		// A card that moved up starts above its place.
		expect(slideOffset({ at: "message-2", top: 400 }, 0, 700)).toBe(-300);
		// A card that did not change its place on screen does not move.
		expect(slideOffset({ at: "message-2", top: 500 }, 200, 300)).toBe(0);
	});
});
